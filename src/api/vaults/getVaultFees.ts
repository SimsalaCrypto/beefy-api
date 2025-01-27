import BigNumber from 'bignumber.js';
import { ContractCallContext, ContractCallResults, Multicall } from 'ethereum-multicall';
import { addressBookByChainId, ChainId } from '../../../packages/address-book/address-book';
import { getContractWithProvider } from '../../utils/contractHelper';
import { getKey, setKey } from '../../utils/cache';
import { web3Factory } from '../../utils/web3';
import { ApiChain, fromChainId } from '../../utils/chain';
import { MULTICALL_V3 } from '../../utils/web3Helpers';

const FeeABI = require('../../abis/FeeABI.json');
const { getMultichainVaults } = require('../stats/getMultichainVaults');

const feeBatchTreasurySplitMethodABI = [
  {
    inputs: [],
    name: 'treasuryFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const INIT_DELAY = 15000;
const REFRESH_INTERVAL = 5 * 60 * 1000;
const CACHE_EXPIRY = 1000 * 60 * 60 * 12;
const MULTICALL_BATCH_SIZES: Partial<Record<ApiChain, number>> = {
  polygon: 25,
};

const DEFAULT_MULTICALL_BATCH_SIZE = 100;

const VAULT_FEES_KEY = 'VAULT_FEES';
const FEE_BATCH_KEY = 'FEE_BATCHES';

const batchSizeForChain = (chain: ApiChain) => {
  return MULTICALL_BATCH_SIZES[chain] ?? DEFAULT_MULTICALL_BATCH_SIZE;
};

interface PerformanceFee {
  total: number;
  call: number;
  strategist: number;
  treasury: number;
  stakers: number;
}

interface VaultFeeBreakdown {
  performance: PerformanceFee;
  withdraw: number;
  deposit?: number;
  lastUpdated: number;
}

interface FeeBatchDetail {
  address: string;
  treasurySplit: number;
  stakerSplit: number;
}

interface PerformanceFeeCallResponse {
  total: BigNumber;
  beefy: BigNumber;
  strategist: BigNumber;
  call: BigNumber;
}

interface StrategyCallResponse {
  id: string;
  strategy: string;
  strategist?: number;
  strategist2?: number;
  call?: number;
  call2?: number;
  call3?: number;
  call4?: number;
  maxCallFee?: number;
  beefy?: number;
  fee?: number;
  treasury?: number;
  rewards?: number;
  rewards2?: number;
  breakdown?: PerformanceFeeCallResponse;
  allFees?: {
    performance: PerformanceFeeCallResponse;
    withdraw: BigNumber;
    deposit: BigNumber;
  };
  maxFee?: number;
  maxFee2?: number;
  maxFee3?: number;
  withdraw?: number;
  withdraw2?: number;
  withdrawMax?: number;
  withdrawMax2?: number;
  paused?: boolean;
}

let feeBatches: Partial<Record<ChainId, FeeBatchDetail>>;
let vaultFees: Record<string, VaultFeeBreakdown>;

const updateFeeBatches = async () => {
  for (const chainId of Object.keys(addressBookByChainId)) {
    const feeBatchAddress = addressBookByChainId[chainId].platforms.beefyfinance.beefyFeeRecipient;
    const web3 = web3Factory(Number(chainId));

    const feeBatchContract = getContractWithProvider(
      feeBatchTreasurySplitMethodABI,
      feeBatchAddress,
      web3
    );

    let treasurySplit;

    try {
      treasurySplit = await feeBatchContract.methods.treasuryFee().call();
    } catch (err) {
      //If reverted, method isn't available on contract so must be older split
      if (err.message.includes('revert') || err.message.includes('correct ABI')) {
        treasurySplit = 140;
      } else if (
        Number(chainId) === ChainId.zksync &&
        err.message.includes('cannot estimate gas')
      ) {
        // TODO: remove once we have feebatch
        treasurySplit = 640;
        console.warn(
          `> feeBatch.treasuryFee() failed on chain ${chainId} - using new default treasury split of 640/1000`
        );
      } else {
        console.log(` > Error updating feeBatch on chain ${chainId}`);
        console.log(err.message);
      }
    }

    if (treasurySplit) {
      feeBatches[chainId] = {
        address: feeBatchAddress,
        treasurySplit: treasurySplit / 1000,
        stakerSplit: 1 - treasurySplit / 1000,
      };
    }
  }

  await setKey(FEE_BATCH_KEY, feeBatches);
  console.log(`> feeBatches updated`);
};

const updateVaultFees = async () => {
  console.log(`> updating vault fees`);
  let start = Date.now();
  let vaults = getMultichainVaults();

  let promises = [];

  for (const chain of Object.keys(addressBookByChainId).map(c => Number(c))) {
    const chainVaults = vaults
      .filter(vault => vault.chain === ChainId[chain])
      .filter(v => !vaultFees[v.id] || Date.now() - vaultFees[v.id].lastUpdated > CACHE_EXPIRY);
    promises.push(getChainFees(chainVaults, chain, feeBatches[chain])); // can throw if no feeBatch (e.g. due to rpc error)
  }

  await Promise.allSettled(promises);
  await saveToRedis();

  console.log(`> updated vault fees (${(Date.now() - start) / 1000}s)`);
  setTimeout(updateVaultFees, REFRESH_INTERVAL);
};

const saveToRedis = async () => {
  await setKey(VAULT_FEES_KEY, vaultFees);
};

const getChainFees = async (vaults, chainId: number, feeBatch: FeeBatchDetail) => {
  try {
    const web3 = web3Factory(chainId);
    const multicallAddress = MULTICALL_V3[chainId];
    if (!multicallAddress) {
      console.warn(`> Fees: Skipping chain ${chainId} as no multicall address found`);
      return;
    }

    const multicall = new Multicall({
      web3Instance: web3,
      tryAggregate: true,
      multicallCustomContractAddress: multicallAddress,
    });
    const contractCallContext: ContractCallContext[] = [];

    vaults.forEach(vault => {
      contractCallContext.push({
        reference: vault.id,
        contractAddress: vault.strategy,
        abi: FeeABI,
        calls: [
          { reference: 'strategist', methodName: 'strategistFee', methodParameters: [] },
          { reference: 'strategist2', methodName: 'STRATEGIST_FEE', methodParameters: [] },
          { reference: 'call', methodName: 'callFee', methodParameters: [] },
          { reference: 'call2', methodName: 'CALL_FEE', methodParameters: [] },
          { reference: 'call3', methodName: 'callfee', methodParameters: [] },
          { reference: 'call4', methodName: 'callFeeAmount', methodParameters: [] },
          { reference: 'maxCallFee', methodName: 'MAX_CALL_FEE', methodParameters: [] },
          { reference: 'beefy', methodName: 'beefyFee', methodParameters: [] },
          { reference: 'fee', methodName: 'fee', methodParameters: [] },
          { reference: 'treasury', methodName: 'TREASURY_FEE', methodParameters: [] },
          { reference: 'rewards', methodName: 'REWARDS_FEE', methodParameters: [] },
          { reference: 'rewards2', methodName: 'rewardsFee', methodParameters: [] },
          { reference: 'breakdown', methodName: 'getFees', methodParameters: [] },
          { reference: 'allFees', methodName: 'getAllFees', methodParameters: [] },
          { reference: 'maxFee', methodName: 'MAX_FEE', methodParameters: [] },
          { reference: 'maxFee2', methodName: 'max', methodParameters: [] },
          { reference: 'maxFee3', methodName: 'maxfee', methodParameters: [] },
          { reference: 'withdraw', methodName: 'withdrawalFee', methodParameters: [] },
          { reference: 'withdraw2', methodName: 'WITHDRAWAL_FEE', methodParameters: [] },
          { reference: 'withdrawMax', methodName: 'WITHDRAWAL_MAX', methodParameters: [] },
          { reference: 'withdrawMax2', methodName: 'withdrawalMax', methodParameters: [] },
          { reference: 'paused', methodName: 'paused', methodParameters: [] },
        ],
      });
    });

    let promises: Promise<ContractCallResults>[] = [];
    const batchSize = batchSizeForChain(fromChainId(chainId));

    for (let i = 0; i < contractCallContext.length; i += batchSize) {
      let batch = contractCallContext.slice(i, i + batchSize);
      promises.push(multicall.call(batch));
    }

    let results = await Promise.allSettled(promises);
    results.forEach(res => {
      if (res.status === 'fulfilled') {
        const callResponses: StrategyCallResponse[] = mapMulticallResults(res.value);
        for (const contractCalls of callResponses) {
          let fees = mapStrategyCallsToFeeBreakdown(contractCalls, feeBatch);
          if (fees) {
            vaultFees[contractCalls.id] = fees;
          } else {
            console.log(' > Failed to get fees for ' + contractCalls.id);
          }
        }
      } else {
        console.log('> multicall batch failed fetching fees on chain ' + chainId);
        console.log(res.reason);
      }
    });
  } catch (err) {
    console.log('> feeUpdate error on chain ' + chainId);
    console.log(err.message);
  }
};

const mapMulticallResults = (results: ContractCallResults): StrategyCallResponse[] => {
  return Object.entries(results.results).map(([vaultId, result]) => {
    let mappedObject: StrategyCallResponse = {
      id: vaultId,
      strategy: result.originalContractCallContext.contractAddress,
    };

    result.callsReturnContext.forEach(callReturn => {
      if (callReturn.decoded) {
        if (callReturn.reference === 'allFees') {
          mappedObject[callReturn.reference] = {
            performance: {
              total: new BigNumber(callReturn.returnValues[0][0].hex),
              beefy: new BigNumber(callReturn.returnValues[0][1].hex),
              call: new BigNumber(callReturn.returnValues[0][2].hex),
              strategist: new BigNumber(callReturn.returnValues[0][3].hex),
            },
            deposit: new BigNumber(callReturn.returnValues[1].hex),
            withdraw: new BigNumber(callReturn.returnValues[2].hex),
          };
        } else if (callReturn.reference === 'breakdown') {
          mappedObject[callReturn.reference] = {
            total: new BigNumber(callReturn.returnValues[0].hex),
            beefy: new BigNumber(callReturn.returnValues[1].hex),
            call: new BigNumber(callReturn.returnValues[2].hex),
            strategist: new BigNumber(callReturn.returnValues[3].hex),
          };
        } else if (callReturn.returnValues[0].type === 'BigNumber') {
          mappedObject[callReturn.reference] = new BigNumber(
            callReturn.returnValues[0].hex
          ).toNumber();
        } else {
          mappedObject[callReturn.reference] = callReturn.returnValues[0];
        }
      }
    });

    return mappedObject;
  });
};

const mapStrategyCallsToFeeBreakdown = (
  contractCalls: StrategyCallResponse,
  feeBatch: FeeBatchDetail
): VaultFeeBreakdown => {
  let withdrawFee = withdrawalFeeFromCalls(contractCalls);

  let performanceFee = performanceFeesFromCalls(contractCalls, feeBatch);

  let depositFee = depositFeeFromCalls(contractCalls);

  if (withdrawFee === undefined) {
    console.log(`Failed to find withdrawFee for ${contractCalls.id}`);
    return undefined;
  } else if (performanceFee === undefined) {
    console.log(`Failed to find performanceFee for ${contractCalls.id}`);
    return undefined;
  }

  return {
    performance: performanceFee,
    withdraw: withdrawFee,
    ...(depositFee != null ? { deposit: depositFee } : {}),
    lastUpdated: Date.now(),
  };
};

const depositFeeFromCalls = (contractCalls: StrategyCallResponse): number => {
  if (contractCalls.allFees) {
    return contractCalls.allFees.deposit.toNumber() / 10000;
  }
  return null; // null and not 0 so that we can avoid adding this into the response for old strategies (fees hardcoded in vault files)
};

const withdrawalFeeFromCalls = (contractCalls: StrategyCallResponse): number => {
  if (contractCalls.allFees) {
    return contractCalls.allFees.withdraw.toNumber() / 10000;
  } else if (
    (contractCalls.withdraw === undefined && contractCalls.withdraw2 === undefined) ||
    (contractCalls.withdrawMax === undefined && contractCalls.withdrawMax2 === undefined) ||
    contractCalls.paused
  ) {
    return 0;
  } else {
    let withdrawFee = contractCalls.withdraw ?? contractCalls.withdraw2;
    let maxWithdrawFee = contractCalls.withdrawMax ?? contractCalls.withdrawMax2;
    return withdrawFee / maxWithdrawFee;
  }
};

const performanceFeesFromCalls = (
  contractCalls: StrategyCallResponse,
  feeBatch: FeeBatchDetail
): PerformanceFee => {
  if (contractCalls.allFees !== undefined) {
    return performanceFromGetFees(contractCalls.allFees.performance, feeBatch);
  } else if (contractCalls.breakdown !== undefined) {
    //newest method
    return performanceFromGetFees(contractCalls.breakdown, feeBatch);
  } else if (contractCalls.id.includes('-maxi')) {
    return performanceForMaxi(contractCalls);
  } else {
    return legacyFeeMappings(contractCalls, feeBatch);
  }
};

const legacyFeeMappings = (
  contractCalls: StrategyCallResponse,
  feeBatch: FeeBatchDetail
): PerformanceFee => {
  let total = 0.045;
  let performanceFee: PerformanceFee;

  let callFee =
    contractCalls.call ?? contractCalls.call2 ?? contractCalls.call3 ?? contractCalls.call4;
  let strategistFee = contractCalls.strategist ?? contractCalls.strategist2;
  let maxFee = contractCalls.maxFee ?? contractCalls.maxFee2 ?? contractCalls.maxFee3;
  let beefyFee = contractCalls.beefy;
  let fee = contractCalls.fee;
  let treasury = contractCalls.treasury;
  let rewards = contractCalls.rewards ?? contractCalls.rewards2;

  if (callFee + strategistFee + beefyFee === maxFee) {
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: (total * strategistFee) / maxFee,
      treasury: (total * feeBatch.treasurySplit * beefyFee) / maxFee,
      stakers: (total * feeBatch.stakerSplit * beefyFee) / maxFee,
    };
  } else if (callFee + strategistFee + rewards + treasury === maxFee) {
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: (total * strategistFee) / maxFee,
      treasury: (total * treasury) / maxFee,
      stakers: (total * rewards) / maxFee,
    };
  } else if (fee + callFee === maxFee) {
    total = 0.05;
    performanceFee = {
      total: total,
      call: (total * callFee) / maxFee,
      strategist: 0,
      treasury: 0,
      stakers: (total * fee) / maxFee,
    };
  } else if (!isNaN(strategistFee + callFee + beefyFee)) {
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: (total * strategistFee) / maxFee,
      treasury: (total * feeBatch.treasurySplit * beefyFee) / maxFee,
      stakers: (total * feeBatch.stakerSplit * beefyFee) / maxFee,
    };
  } else if (!isNaN(strategistFee + callFee + treasury)) {
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: (total * strategistFee) / maxFee,
      treasury: (total * treasury) / maxFee,
      stakers: 0,
    };
  } else if (callFee + treasury + rewards === maxFee) {
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: 0,
      treasury: (total * treasury) / maxFee,
      stakers: (total * rewards) / maxFee,
    };
  } else if (callFee + beefyFee === maxFee) {
    if (contractCalls.id === 'cake-cakev2-eol') total = 0.01;
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: 0,
      treasury: (total * feeBatch.treasurySplit * beefyFee) / maxFee,
      stakers: (total * feeBatch.stakerSplit * beefyFee) / maxFee,
    };
  } else if (callFee + fee === maxFee) {
    performanceFee = {
      total,
      call: (total * callFee) / maxFee,
      strategist: 0,
      treasury: 0,
      stakers: (total * fee) / maxFee,
    };
  } else {
    console.log(
      `> Performance fee fetch failed for: ${contractCalls.id} - ${contractCalls.strategy}`
    );
  }

  return performanceFee;
};

const performanceFromGetFees = (
  fees: PerformanceFeeCallResponse,
  feeBatch: FeeBatchDetail
): PerformanceFee => {
  let total = fees.total.div(1e9).toNumber() / 1e9;
  let beefy = fees.beefy.div(1e9).toNumber() / 1e9;
  let call = fees.call.div(1e9).toNumber() / 1e9;
  let strategist = fees.strategist.div(1e9).toNumber() / 1e9;

  const feeSum = beefy + call + strategist;
  const beefySplit = (total * beefy) / feeSum;

  let feeBreakdown = {
    total: total,
    call: (total * call) / feeSum,
    strategist: (total * strategist) / feeSum,
    treasury: feeBatch.treasurySplit * beefySplit,
    stakers: feeBatch.stakerSplit * beefySplit,
  };
  return feeBreakdown;
};

const performanceForMaxi = (contractCalls: StrategyCallResponse): PerformanceFee => {
  let performanceFee: PerformanceFee;

  let callFee =
    contractCalls.call ?? contractCalls.call2 ?? contractCalls.call3 ?? contractCalls.call4;
  let maxCallFee = contractCalls.maxCallFee ?? 1000;
  let maxFee = contractCalls.maxFee ?? contractCalls.maxFee2 ?? contractCalls.maxFee3;
  let rewards = contractCalls.rewards ?? contractCalls.rewards2;

  let strategyAddress = contractCalls.strategy.toLowerCase();

  // Specific contracts with distinct method for charging fees
  if (
    [
      '0x436D5127F16fAC1F021733dda090b5E6DE30b3bB'.toLowerCase(),
      '0xa9E6E271b27b20F65394914f8784B3B860dBd259'.toLowerCase(),
    ].includes(strategyAddress)
  ) {
    performanceFee = {
      total: callFee / 1000,
      strategist: 0,
      call: callFee / 1000,
      treasury: 0,
      stakers: 0,
    };

    //Another bunch of legacy contracts
  } else if (
    [
      '0x24AAaB9DA14308bAf9d670e2a37369FE8Cb5Fe36',
      '0x22b3d90BDdC3Ad5F2948bE3914255C64Ebc8c9b3',
      '0xbCF1e02ac0c45729dC85F290C4A6AB35c4801cB1',
      '0xb25eB9105549627050AAB3A1c909fBD454014beA',
    ]
      .map(address => address.toLowerCase())
      .includes(strategyAddress)
  ) {
    performanceFee = {
      total: ((45 / 1000) * callFee) / maxFee,
      strategist: 0,
      call: ((45 / 1000) * callFee) / maxFee,
      treasury: 0,
      stakers: 0,
    };
  } else if ('0xca077eEC87e2621F5B09AFE47C42BAF88c6Af18c'.toLowerCase() === strategyAddress) {
    //avax maxi
    performanceFee = {
      total: 5 / 1000,
      strategist: 0,
      call: 5 / 1000,
      treasury: 0,
      stakers: 0,
    };
  } else if ('0x87056F5E8Dce0fD71605E6E291C6a3B53cbc3818'.toLowerCase() === strategyAddress) {
    //old bifi maxi
    performanceFee = {
      total: (callFee + rewards) / maxFee,
      strategist: 0,
      call: callFee / maxFee,
      treasury: 0,
      stakers: rewards / maxFee,
    };
  } else {
    performanceFee = {
      total: callFee / maxCallFee,
      strategist: 0,
      call: callFee / maxCallFee,
      treasury: 0,
      stakers: 0,
    };
  }
  return performanceFee;
};

export const initVaultFeeService = async () => {
  const cachedVaultFees = await getKey<Record<string, VaultFeeBreakdown>>(VAULT_FEES_KEY);
  const cachedFeeBatches = await getKey<Record<ChainId, FeeBatchDetail>>(FEE_BATCH_KEY);

  feeBatches = cachedFeeBatches ?? {};
  vaultFees = cachedVaultFees ?? {};

  await updateFeeBatches();

  setTimeout(() => {
    updateVaultFees();
  }, INIT_DELAY);
};

export const getVaultFees = () => {
  return vaultFees;
};

export const getTotalPerformanceFeeForVault = (vaultId: string) => {
  if (!vaultFees[vaultId]) {
    // console.log(`[FEES]> Missing fees for vault ${vaultId}`);
    return 0.095;
  }
  return vaultFees[vaultId].performance.total;
};
