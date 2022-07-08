const AxiosBatchProvider = require('./dist/cjs');

const test = async () => {
  const provider = new AxiosBatchProvider('https://bsc-dataseed.binance.org, https://binance.nodereal.io, https://bscrpc.com', { debug: true, retryMax: 0, timeout: 1000 });
  const data = await provider.getBlockNumber();
  console.log(data);
}


test();
