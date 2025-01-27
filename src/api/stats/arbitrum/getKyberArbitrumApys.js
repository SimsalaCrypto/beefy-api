const { arbitrumWeb3: web3 } = require('../../../utils/web3');
const { ARBITRUM_CHAIN_ID: chainId } = require('../../../constants');
const { getKyberLpV2Apys } = require('../common/getKyberLpV2Apys');
const ABI = require('../../../abis/IKyberFairLaunch.json');
const pools = require('../../../data/arbitrum/kyberLpPools.json');

const getKyberArbitrumApys = async () => {
  return getKyberLpV2Apys({
    web3: web3,
    chainId: chainId,
    pools: pools,
    abi: ABI,
    // log: true,
  });
};

module.exports = getKyberArbitrumApys;
