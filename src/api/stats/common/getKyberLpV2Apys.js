const BigNumber = require('bignumber.js');
const { MultiCall } = require('eth-multicall');

const DMMPool = require('../../../abis/matic/DMMPool.json');
const fetchPrice = require('../../../utils/fetchPrice');
const { getVariableTradingFeeApr } = require('../../../utils/getTradingFeeApr');
import { getContract } from '../../../utils/contractHelper';
import { getYearlyRewardsInUsd } from './curve/getCurveApyData';
const { kyberClient } = require('../../../apollo/client');
import getApyBreakdown from './getApyBreakdown';

const { multicallAddress } = require('../../../utils/web3');

const oracleId = 'KNC';
const oracle = 'tokens';
const DECIMALS = '1e18';

const getKyberLpV2Apys = async params => {
  const { farmAprs, tradingAprs, tradingFees } = await getAprs(params);

  console.log;
  return await getApyBreakdown(params.pools, 0, farmAprs, 0);
};

const getAprs = async params => {
  const farmAprs = [];
  const tradingAprs = [];

  const tokenPrice = await fetchPrice({ oracle: oracle, id: oracleId });
  const { balances, rewardRates, endTimes, tradingFees } = await getPoolsData(params);

  const pairAddresses = params.pools.map(pool => pool.lp0.address.concat('_', pool.lp1.address));
  const fetchedTradingAprs = await getVariableTradingFeeApr(
    kyberClient,
    pairAddresses,
    tradingFees
  );

  for (let i = 0; i < params.pools.length; i++) {
    const pool = params.pools[i];

    const stakedPrice = await fetchPrice({ oracle: 'lps', id: pool.name });
    const totalStakedInUsd = balances[i].times(stakedPrice).dividedBy(pool.decimals ?? '1e18');

    const secondsPerYear = 31536000;
    let yearlyRewardsInUsd = new BigNumber(0);
    if (endTimes[i] > Date.now() / 1000) {
      const yearlyRewards = pool.v2
        ? new BigNumber(rewardRates[i][pool.kncIndex]).times(secondsPerYear)
        : new BigNumber(rewardRates[i]).times(secondsPerYear);
      yearlyRewardsInUsd = yearlyRewards.times(tokenPrice).dividedBy(DECIMALS);

      if (pool.rewards) {
        const rewardPrice = await fetchPrice({ oracle: 'tokens', id: pool.rewards[0].oracleId });
        const yearlyRewardsExtra = new BigNumber(rewardRates[i][pool.rewardIndex]).times(
          secondsPerYear
        );
        yearlyRewardsInUsd = yearlyRewardsInUsd.plus(
          yearlyRewardsExtra.times(rewardPrice).dividedBy(DECIMALS)
        );
      }
    }

    const apr = yearlyRewardsInUsd.dividedBy(totalStakedInUsd);

    if (params.log) {
      console.log(
        pool.name,
        yearlyRewardsInUsd.toNumber(),
        totalStakedInUsd.toNumber(),
        apr.toNumber()
      );
    }

    farmAprs.push(apr);
  }

  return { farmAprs, tradingAprs, tradingFees };
};

const getPoolsData = async params => {
  const multicall = new MultiCall(params.web3, multicallAddress(params.chainId));
  const balanceCalls = [];
  const poolInfoCalls = [];
  const tradingFeeCalls = [];
  params.pools.forEach(pool => {
    const masterchefContract = getContract(params.abi, pool.fairLaunch);
    const tokenContract = getContract(DMMPool, pool.address);
    balanceCalls.push({
      balance: tokenContract.methods.balanceOf(pool.fairLaunch),
    });
    poolInfoCalls.push({
      poolInfo: masterchefContract.methods.getPoolInfo(pool.poolId),
    });
    tradingFeeCalls.push({
      tradingFee: tokenContract.methods.getTradeInfo(),
    });
  });

  const res = await multicall.all([balanceCalls, poolInfoCalls, tradingFeeCalls]);

  const balances = res[0].map(v => new BigNumber(v.balance));
  const rewardRates = res[1].map(v => v.poolInfo['7']);
  const endTimes = res[1].map(v => v.poolInfo['4']);
  const tradingFees = res[2].map(v => new BigNumber(v.tradingFee['4']).dividedBy(DECIMALS));

  return { balances, rewardRates, endTimes, tradingFees };
};

module.exports = { getKyberLpV2Apys };
