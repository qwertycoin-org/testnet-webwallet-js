/*
 * Copyright (c) 2018, Gnock
 * Copyright (c) 2018, The Masari Project
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import {BlockchainExplorer} from "./BlockchainExplorer";
import {Wallet} from "../Wallet";
import {TransactionsExplorer} from "../TransactionsExplorer";
import {Transaction} from "../Transaction";
import {MathUtil} from "../MathUtil";
import {Constants} from "../Constants";

export class WalletWatchdog {

    wallet: Wallet;
    explorer: BlockchainExplorerRpc2;
    intervalMempool = 0;
    stopped: boolean = false;
    transactionsToProcess: RawDaemonTransaction[] = [];
    intervalTransactionsProcess = 0;
    workerProcessing !: Worker;
    workerProcessingReady = false;
    workerProcessingWorking = false;
    workerCurrentProcessing: RawDaemonTransaction[] = [];
    workerCountProcessed = 0;
    lastBlockLoading = -1;
    lastMaximumHeight = 0;

    constructor(wallet: Wallet, explorer: BlockchainExplorerRpc2) {
        this.wallet = wallet;
        this.explorer = explorer;

        this.initWorker();
        this.initMempool();
    }

    initWorker() {
        let self = this;
        this.workerProcessing = new Worker('./workers/TransferProcessingEntrypoint.js');
        this.workerProcessing.onmessage = function (data: MessageEvent) {
            let message: string | any = data.data;
            if (Constants.DEBUG_STATE) {
                console.log("InitWorker message: ");
                console.log(message);
            }
            if (message === 'ready') {
                self.signalWalletUpdate();
            } else if (message === 'readyWallet') {
                self.workerProcessingReady = true;
            } else if (message.type) {
                if (message.type === 'processed') {
                    let transactions = message.transactions;
                    if (transactions.length > 0) {
                        for (let tx of transactions) {
                            if (Constants.DEBUG_STATE) {
                                console.log(`Adding new tx ${tx.hash} to the wallet`);
                            }
                            self.wallet.addNew(Transaction.fromRaw(tx));
                        }
                        self.signalWalletUpdate();
                    }
                    if (self.workerCurrentProcessing.length > 0) {
                        let transactionHeight = self.workerCurrentProcessing[self.workerCurrentProcessing.length - 1].blockIndex;
                        if (typeof transactionHeight !== 'undefined') {
                            self.wallet.lastHeight = transactionHeight;
                        } else {
                            self.wallet.lastHeight = self.lastBlockLoading;
                        }
                    }

                    self.workerProcessingWorking = false;
                }
            }
        };
    }

    signalWalletUpdate() {
        let self = this;
        this.lastBlockLoading = -1;//reset scanning
        this.workerProcessing.postMessage({
            type: 'initWallet',
            wallet: this.wallet.exportToRaw()
        });
        clearInterval(this.intervalTransactionsProcess);
        this.intervalTransactionsProcess = setInterval(function () {
            self.checkTransactionsInterval();
        }, this.wallet.options.readSpeed);
    }

    initMempool() {
        let self = this;
        if (this.intervalMempool === 0) {
            this.intervalMempool = setInterval(function () {
                self.checkMempool();
            }, 30 * 1000);
        }
        self.checkMempool();
    }

    stop() {
        clearInterval(this.intervalTransactionsProcess);
        this.transactionsToProcess = [];
        clearInterval(this.intervalMempool);
        this.stopped = true;
    }

    checkMempool(): boolean {
        let self = this;
        if (this.lastMaximumHeight - this.lastBlockLoading > 1) {//only check memory pool if the user is up to date to ensure outs & ins will be found in the wallet
            return false;
        }

        this.wallet.txsMem = [];
        this.explorer.getTransactionPool().then(function (pool: any) {
            if (typeof pool !== 'undefined')
                for (let rawTx of pool) {
                    let tx = TransactionsExplorer.parse(rawTx, self.wallet);
                    if (tx !== null) {
                        self.wallet.txsMem.push(tx);
                    }
                }
        }).catch(function () {
        });
        return true;
    }

    terminateWorker() {
        this.workerProcessing.terminate();
        this.workerProcessingReady = false;
        this.workerCurrentProcessing = [];
        this.workerProcessingWorking = false;
        this.workerCountProcessed = 0;
    }

    checkTransactions(rawTransactions: RawDaemonTransaction[]) {
        for (let rawTransaction of rawTransactions) {
            let height = rawTransaction.height;
            if (typeof height !== 'undefined') {
                let transaction = TransactionsExplorer.parse(rawTransaction, this.wallet);
                if (transaction !== null) {
                    this.wallet.addNew(transaction);
                }
                if (height - this.wallet.lastHeight >= 2) {
                    this.wallet.lastHeight = height - 1;
                }
            }
        }
        if (this.transactionsToProcess.length == 0) {
            this.wallet.lastHeight = this.lastBlockLoading;
        }
    }

    checkTransactionsInterval() {

        //somehow we're repeating and regressing back to re-process Tx's
        //loadHistory getting into a stack overflow ?
        //need to work out timinings and ensure process does not reload when it's already running...

        if (this.workerProcessingWorking || !this.workerProcessingReady) {
            return;
        }

        //we destroy the worker in charge of decoding the transactions every 250 transactions to ensure the memory is not corrupted
        //cnUtil bug, see https://github.com/mymonero/mymonero-core-js/issues/8
        if (this.workerCountProcessed >= 75) {
            if (Constants.DEBUG_STATE) {
                console.log('Recreate worker..');
            }
            this.terminateWorker();
            this.initWorker();
            return;
        }

        let transactionsToProcess: RawDaemonTransaction[] = this.transactionsToProcess.splice(0, 50); //process 50 tx's at a time
        if (transactionsToProcess.length > 0) {
            this.workerCurrentProcessing = transactionsToProcess;
            this.workerProcessing.postMessage({
                type: 'process',
                transactions: transactionsToProcess
            });
            ++this.workerCountProcessed;
            this.workerProcessingWorking = true;
        } else {
            clearInterval(this.intervalTransactionsProcess);
            this.intervalTransactionsProcess = 0;
        }
    }

    processTransactions(transactions: RawDaemonTransaction[]) {
        let transactionsToAdd = [];

        for (let tr of transactions) {
            if (typeof tr.height !== 'undefined')
                if (tr.height > this.wallet.lastHeight) {
                    transactionsToAdd.push(tr);
                }
        }

        this.transactionsToProcess.push.apply(this.transactionsToProcess, transactionsToAdd);
        if (this.intervalTransactionsProcess === 0) {
            let self = this;
            this.intervalTransactionsProcess = setInterval(function () {
                self.checkTransactionsInterval();
            }, this.wallet.options.readSpeed);
        }

    }

    loadHistory() {
        if (this.stopped) return;

        if (this.lastBlockLoading === -1) this.lastBlockLoading = this.wallet.lastHeight;
        let self = this;
        //don't reload until it's finished processing the last batch of transactions
        if (this.workerProcessingWorking || !this.workerProcessingReady) {
            setTimeout(function () {
                self.loadHistory();
            }, 250);
            return;
        }
        if (this.transactionsToProcess.length > 100) {
            //to ensure no pile explosion
            setTimeout(function () {
                self.loadHistory();
            }, 1 * 1000);
            return;
        }

        if (Constants.DEBUG_STATE) {
            console.log('checking');
        }
        this.explorer.getHeight().then(function (height) {
            if (Constants.DEBUG_STATE) {
                console.log(self.lastBlockLoading, height);
            }
            if (height > self.lastMaximumHeight) self.lastMaximumHeight = height;

            if (self.lastBlockLoading !== height) {
                let previousStartBlock = self.lastBlockLoading;
                let startBlock = Math.floor(self.lastBlockLoading / 100) * 100;
                if (Constants.DEBUG_STATE) {
                    // console.log('=>',self.lastBlockLoading, endBlock, height, startBlock, self.lastBlockLoading);
                    console.log('load block from ' + startBlock);
                    console.log('previousStartBlock: ' + previousStartBlock)
                }
                self.explorer.getTransactionsForBlocks(previousStartBlock).then(function (transactions: RawDaemonTransaction[]) {
                    //to ensure no pile explosion
                    if (Constants.DEBUG_STATE) {
                        console.log("transactions length: " + transactions.length);
                    }
                    if (transactions.length > 0) {
                        let lastTx = transactions[transactions.length - 1];
                        if (Constants.DEBUG_STATE) {
                            // @ts-ignore
                            console.log("lastTx.blockIndex + 1: " + (lastTx.blockIndex + 1));
                        }
                        if (typeof lastTx.height !== 'undefined') {
                            self.lastBlockLoading = lastTx.blockIndex + 1;
                            if (Constants.DEBUG_STATE) {
                                // @ts-ignore
                                console.log("self.lastBlockLoading: " + self.lastBlockLoading);
                            }
                        }
                    } else {
                        if (self.lastBlockLoading < height) {
                            self.lastBlockLoading += 100;
                        } else {
                            self.lastBlockLoading = height;
                        }
                    }

                    self.processTransactions(transactions);

                    setTimeout(function () {
                        self.loadHistory();
                    }, 1);
                }).catch(function () {
                    setTimeout(function () {
                        self.loadHistory();
                    }, 30 * 1000);//retry 30s later if an error occurred
                });
            } else {
                setTimeout(function () {
                    self.loadHistory();
                }, 30 * 1000);
            }
        }).catch(function () {
            setTimeout(function () {
                self.loadHistory();
            }, 30 * 1000);//retry 30s later if an error occurred
        });
    }


}

export class BlockchainExplorerRpc2 implements BlockchainExplorer {

    // testnet : boolean = true;
    randInt = Math.floor(Math.random() * Math.floor(config.apiUrl.length));
    randNodeInt = Math.floor(Math.random() * Math.floor(config.nodeList.length));
    serverAddress = config.apiUrl[this.randInt];
    nodeAddress = config.nodeList[this.randNodeInt];

    heightCache = 0;
    heightLastTimeRetrieve = 0;
    scannedHeight: number = 0;
    nonRandomBlockConsumed = false;
    existingOuts: any[] = [];

    getHeight(): Promise<number> {
        if (Date.now() - this.heightLastTimeRetrieve < 20 * 1000 && this.heightCache !== 0) {
            return Promise.resolve(this.heightCache);
        }

        let self = this;
        this.heightLastTimeRetrieve = Date.now();
        return new Promise<number>(function (resolve, reject) {
            self.postData(self.nodeAddress + 'getheight', {}).then(data => {
                self.heightCache = parseInt(data.height);
                resolve(self.heightCache);
            }).catch(error => {
                if (Constants.DEBUG_STATE) {
                    console.log('REJECT');
                }
                try {
                    console.log(JSON.parse(error.responseText));
                } catch (e) {
                    console.log(e);
                }
                reject(error);
            });
        });
    }

    getScannedHeight(): number {
        return this.scannedHeight;
    }

    watchdog(wallet: Wallet): WalletWatchdog {
        let watchdog = new WalletWatchdog(wallet, this);
        watchdog.loadHistory();
        return watchdog;
    }

    getRemoteNodeInformation(): Promise<RemoteNodeInformation> {
        let self = this;

        let information: RemoteNodeInformation;

        return new Promise<RemoteNodeInformation>(function (resolve, reject) {

            self.postData(self.nodeAddress + 'getinfo', {}).then(resp => {
                information.fee_address = resp.fee_address;
                information.status = resp.status;

                resolve(information);
            }).catch(error => {
                if (Constants.DEBUG_STATE) {
                    console.log('REJECT');
                }
                try {
                    console.log(JSON.parse(error.responseText));
                } catch (e) {
                    console.log(e);
                }
                reject(error);
            });
        })
    }

    getTransactionsForBlocks(startBlock: number): Promise<RawDaemonTransaction[]> {
        let self = this;
        let transactions: RawDaemonTransaction[] = [];

        return new Promise<RawDaemonTransaction[]>(function (resolve, reject) {
            if (Constants.DEBUG_STATE) {
                console.log("startBlock: " + startBlock);
            }
            let outCount: any;
            let finalTxs: any[] = [];
            let height = startBlock;
            let additor = 100;

            self.postData(self.nodeAddress + 'get_transaction_details_by_heights', {
                "startBlock": startBlock,
                "additor": additor,
                "sigCut": true
            }).then(response => {
                let parsedResp = response;

                let rawTxs = parsedResp['transactions'];

                if (rawTxs !== null) {
                    if (Constants.DEBUG_STATE) {
                        console.log("rawTxs !== null");
                        console.log(rawTxs);
                    }
                    for (let iTx = 0; iTx < rawTxs.length; ++iTx) {
                        let rawTx = rawTxs[iTx];
                        let finalTx = rawTx;

                        delete finalTx.signatures;
                        delete finalTx.unlockTime;
                        delete finalTx.signatureSize;
                        delete finalTx.ts;
                        finalTx.global_index_start = outCount;
                        finalTx.ts = rawTx.timestamp;
                        finalTx.height = height;
                        finalTx.hash = rawTx.hash;
                        finalTxs.push(finalTx);

                        let vOutCount = finalTx.outputs.length;
                        outCount += vOutCount;
                    }

                    transactions = finalTxs;

                    if (Constants.DEBUG_STATE) {
                        console.log("Show resolvable Tx Hashes");
                        for (let i = 0; i < transactions.length; i++) {
                            console.log(`Tx hash ${transactions[i].hash}`);
                        }
                    }
                    resolve(transactions);
                }
            }).catch(error => {
                if (Constants.DEBUG_STATE) {
                    console.log('REJECT');
                }
                try {
                    console.log(JSON.parse(error.responseText));
                } catch (e) {
                    console.log(e);
                }
                reject(error);
            });
        });
    }

    getTransactionPool(): Promise<RawDaemonTransaction[]> {
        let self = this;
        return new Promise<RawDaemonTransaction[]>(function (resolve, reject) {
            self.postData(self.nodeAddress + 'json_rpc', {
                'jsonrpc': '2.0',
                'id': 0,
                'method': 'f_on_transactions_pool_json',
                'params': ''
            }).then(data => {
                let rawTxs = data.result.transactions;
                let txHashes: any[] = [];

                for (let iTx = 0; iTx < rawTxs.length; iTx++) {
                    txHashes.push(rawTxs[iTx].hash);
                }

                self.postData(self.nodeAddress + 'get_transaction_details_by_hashes', {
                    'transactionHashes': txHashes
                }).then(detailTx => {
                    let response = detailTx.transactions;
                    if (response !== null) {
                        if (Constants.DEBUG_STATE) {
                            console.log("tx mempool:");
                            console.log(response);
                            console.log("node:");
                            console.log(self.nodeAddress);
                        }
                        resolve(response);
                    }
                }).catch(error => {
                    if (Constants.DEBUG_STATE) {
                        console.log('REJECT');
                    }
                    try {
                        console.log(JSON.parse(error.responseText));
                    } catch (e) {
                        console.log(e);
                    }
                    reject(error);
                });
            });
        });
    }

    getRandomOuts(nbOutsNeeded: number, initialCall = true): Promise<any[]> {
        let self = this;
        if (initialCall) {
            self.existingOuts = [];
        }

        return this.getHeight().then(function (height: number) {
            let txs: RawDaemonTransaction[] = [];
            let promises = [];

            let randomBlocksIndexesToGet: number[] = [];
            let numOuts = height;

            for (let i = 0; i < nbOutsNeeded; ++i) {
                let selectedIndex: number = -1;
                do {
                    selectedIndex = MathUtil.randomTriangularSimplified(numOuts);
                    if (selectedIndex >= height - config.txCoinbaseMinConfirms)
                        selectedIndex = -1;
                } while (selectedIndex === -1 || randomBlocksIndexesToGet.indexOf(selectedIndex) !== -1);
                randomBlocksIndexesToGet.push(selectedIndex);

                let promise = self.getTransactionsForBlocks(Math.floor(selectedIndex / 100) * 100).then(function (rawTransactions: RawDaemonTransaction[]) {
                    txs.push.apply(txs, rawTransactions);
                });
                promises.push(promise);
            }

            return Promise.all(promises).then(function () {
                let txCandidates: any = {};
                for (let iOut = 0; iOut < txs.length; ++iOut) {
                    let tx = txs[iOut];

                    if (
                        (typeof tx.height !== 'undefined' && randomBlocksIndexesToGet.indexOf(tx.height) === -1) ||
                        typeof tx.height === 'undefined'
                    ) {
                        continue;
                    }

                    for (let output_idx_in_tx = 0; output_idx_in_tx < tx.outputs.length; ++output_idx_in_tx) {
                        //let globalIndex = output_idx_in_tx;
                        //if (typeof tx.global_index_start !== 'undefined')
                        //    globalIndex += tx.global_index_start;
                        let globalIndex = tx.outputs[output_idx_in_tx].globalIndex;

                        let newOut = {
                            public_key: tx.outputs[output_idx_in_tx].output.target.data.key,
                            global_index: globalIndex,
                            // global_index: count,
                        };
                        if (typeof txCandidates[tx.height] === 'undefined') txCandidates[tx.height] = [];
                        txCandidates[tx.height].push(newOut);
                    }
                }

                if (Constants.DEBUG_STATE) {
                    console.log(txCandidates);
                }

                let selectedOuts = [];
                for (let txsOutsHeight in txCandidates) {
                    let outIndexSelect = MathUtil.getRandomInt(0, txCandidates[txsOutsHeight].length - 1);
                    if (Constants.DEBUG_STATE) {
                        console.log('select ' +
                            outIndexSelect +
                            ' for ' +
                            txsOutsHeight +
                            ' with length of ' +
                            txCandidates[txsOutsHeight].length);
                    }
                    selectedOuts.push(txCandidates[txsOutsHeight][outIndexSelect]);
                }

                if (Constants.DEBUG_STATE) {
                    console.log(selectedOuts);
                }

                return selectedOuts;
            });
        });
    }

    sendRawTx(rawTx: string) {
        let self = this;
        return new Promise(function (resolve, reject) {
            self.postData(self.nodeAddress + 'sendrawtransaction', {
                tx_as_hex: rawTx,
                do_not_relay: false
            }).then(transactions => {
                if (transactions.status && transactions.status == 'OK') {
                    resolve(transactions);
                } else {
                    reject(transactions);
                }
            }).catch(error => {
                reject(error);
            });
        });
    }

    resolveOpenAlias(domain: string): Promise<{ address: string, name: string | null }> {
        let self = this;
        return new Promise(function (resolve, reject) {
            $.ajax({
                url: self.serverAddress + 'openAlias.php?domain=' + domain,
                method: 'GET',
            }).done(function (response: any) {
                resolve(response);
            }).fail(function (data: any) {
                reject(data);
            });
        });
    }

    async postData(url: string, data: any) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });

        return response.json();
    }

}
