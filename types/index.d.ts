/// <reference types="node" />
import { providers } from 'ethers';
import type { fetchConfig } from 'axios-auto';
export declare type extraConfig = Omit<fetchConfig, 'url'>;
export default class AxiosBatchProvider extends providers.JsonRpcProvider {
    private axiosConfig;
    private requestId;
    _pendingBatchAggregator: NodeJS.Timer | null;
    _pendingBatch: Array<{
        request: {
            method: string;
            params: Array<any>;
            id: number;
            jsonrpc: '2.0';
        };
        resolve: (result: any) => void;
        reject: (error: Error) => void;
    }> | null;
    constructor(urlOrConfig: string | fetchConfig, extraConfig?: extraConfig, network?: providers.Networkish);
    send(method: string, params: Array<any>): Promise<any>;
}
