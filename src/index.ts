import { version } from './_version';
import { post } from 'axios-auto';
import { providers, utils } from 'ethers';
import type { fetchConfig, filter } from 'axios-auto';
const logger = new utils.Logger(version);

export type extraConfig = Omit<fetchConfig, 'url'>;

/**
 * Based off JsonRpcBatchProvider
 * https://github.com/ethers-io/ethers.js/blob/v5.2/packages/providers/src.ts/json-rpc-batch-provider.ts#L9
 */
export default class AxiosBatchProvider extends providers.JsonRpcProvider {
  private axiosConfig: fetchConfig;
  private requestId = 1;
  _pendingBatchAggregator: NodeJS.Timer | null;
  _pendingBatch: Array<{
    request: { method: string, params: Array<any>, id: number, jsonrpc: '2.0' },
    resolve: (result: any) => void,
    reject: (error: Error) => void
  }> | null;

  constructor(urlOrConfig: string | fetchConfig, extraConfig?: extraConfig, network?: providers.Networkish) {
    if (typeof urlOrConfig === 'object' && !urlOrConfig.url) {
      logger.throwArgumentError('missing node url', 'urlOrConfig', urlOrConfig);
    }

    const axiosConfig: fetchConfig = {
      url: (typeof urlOrConfig === 'string') ? urlOrConfig : urlOrConfig.url
    };

    if (typeof urlOrConfig === 'object') {
      Object.assign(axiosConfig, urlOrConfig);
    }

    if (extraConfig) {
      Object.assign(axiosConfig, extraConfig);
    }

    axiosConfig.headers ||= {};
    axiosConfig.headers['Content-Type'] ||= 'application/json;charset=utf-8';

    // Extend timeout to 1 minute for requesting historical calls (eth_getLogs)
    axiosConfig.timeout ||= 60000;

    // Tell JsonRpcProvider only one node (While send queries to multiple nodes at once)
    super(axiosConfig.url.replace(/\s+/g, '').split(',')[0], network);
    this.axiosConfig = axiosConfig;
    this._pendingBatchAggregator = null;
    this._pendingBatch = null;
  }

  send(method: string, params: Array<any>): Promise<any> {
    // Return cached eth_chainId if available
    if (method === 'eth_chainId' && this._network?.chainId) {
      return new Promise(resolve => resolve(this._network?.chainId));
    }

    const url = Object.assign({}, this.axiosConfig).url;

    const payload = {
      method,
      params,
      id: (this.requestId++),
      jsonrpc: '2.0'
    };

    type options = extraConfig & {url?: string};
    const options: options = Object.assign({}, this.axiosConfig);
    delete options.url;

    const sendTxMethods = ['eth_sendRawTransaction', 'eth_sendTransaction'];
    const sendTransaction = sendTxMethods.includes(method) ? true : false;

    if (sendTransaction && url.replace(/\s+/g, '').split(',').length > 0) {
      throw new Error('AxiosBatchProvider: eth_sendRawTransaction not supported with multiple nodes');
    }

    /**
     * Filter rpc node generated error
     */
    const filter: filter = (data: any, count?: number, retryMax?: number) => {
      if (typeof count === 'number' && typeof retryMax === 'number') {
        if (Array.isArray(data)) {
          const errorArray = data.map((d: any) => {
            let message: string | undefined;
            // Handle usual error object from remote node
            if (d.error) {
              message = (typeof d.error.message === 'string')
                ? d.error.message : (typeof d.error === 'string')
                  ? d.error : (typeof d.error === 'object')
                    ? JSON.stringify(d.error) : '';
            // Handle custom error from remote node
            } else if (typeof d.result === 'undefined') {
              message = (typeof d === 'string') ? d :
                (typeof d === 'object') ? JSON.stringify(d) :
                  'Result not available from remote node';
            }
            // Throw error to retry inside axios-auto function
            if (typeof message !== 'undefined' && count < retryMax + 1) {
              return new Error(message);
            }
          }).filter(d => d);
          if (errorArray.length > 0) {
            throw errorArray;
          }
        } else {
          let message: string | undefined;
          // Handle usual error object from remote node
          if (data.error) {
            message = (typeof data.error.message === 'string')
              ? data.error.message : (typeof data.error === 'string')
                ? data.error : (typeof data.error === 'object')
                  ? JSON.stringify(data.error) : '';
          // Handle custom error from remote node
          } else if (typeof data.result === 'undefined') {
            message = (typeof data === 'string') ? data :
              (typeof data === 'object') ? JSON.stringify(data) :
                'Result not available from remote node';
          }
          // Throw error to retry inside axios-auto function
          if (typeof message !== 'undefined' && count < retryMax + 1) {
            throw new Error(message);
          }
        }
      }
    };

    options.filter ||= filter;

    if (this._pendingBatch == null) {
      this._pendingBatch = [];
    }

    const inflightRequest: any = { request: payload, resolve: null, reject: null };

    const promise = new Promise((resolve, reject) => {
      inflightRequest.resolve = resolve;
      inflightRequest.reject = reject;
    });

    this._pendingBatch.push(inflightRequest);

    if (!this._pendingBatchAggregator) {
      // Schedule batch for next event loop + short duration
      this._pendingBatchAggregator = setTimeout(() => {

        // Get teh current batch and clear it, so new requests
        // go into the next batch
        const array: any[] = [];
        const batch = Object.assign(array, this._pendingBatch);
        this._pendingBatch = null;
        this._pendingBatchAggregator = null;

        // Get the request as an array of requests
        const request = batch.map((inflight) => inflight.request);

        return post(url, JSON.stringify(request), options).then((result) => {
          if (!Array.isArray(result) || result.length === 1) {
            const payload = !Array.isArray(result) ? result : result[0];
            batch.forEach((inflightRequest) => {
              if (payload.error) {
                const error = new Error(payload.error.message);
                (<any>error).code = payload.error.code;
                (<any>error).data = payload.error.data;
                inflightRequest.reject(error);
              } else if (typeof payload.result === 'undefined') {
                const msg = (typeof payload === 'string') ? payload :
                  (typeof payload === 'object') ? JSON.stringify(payload) :
                    'Result not available from remote node';
                inflightRequest.reject(new Error(msg));
              } else {
                inflightRequest.resolve(payload.result);
              }
            });
          } else {
            // For each result, feed it to the correct Promise, depending
            // on whether it was a success or error
            batch.forEach((inflightRequest, index) => {
              const payload = result[index];
              if (payload.error) {
                const error = new Error(payload.error.message);
                (<any>error).code = payload.error.code;
                (<any>error).data = payload.error.data;
                inflightRequest.reject(error);
              } else if (typeof payload.result === 'undefined') {
                const msg = (typeof payload === 'string') ? payload :
                  (typeof payload === 'object') ? JSON.stringify(payload) :
                    'Result not available from remote node';
                inflightRequest.reject(new Error(msg));
              } else {
                inflightRequest.resolve(payload.result);
              }
            });
          }
        }, (error) => {
          batch.forEach((inflightRequest) => {
            inflightRequest.reject(error);
          });
        });

      }, 10);
    }

    return promise;
  }
}
