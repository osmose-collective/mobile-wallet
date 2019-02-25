import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import 'rxjs/add/operator/expand';

import { UserDataProvider } from '@providers/user-data/user-data';
import { StorageProvider } from '@providers/storage/storage';
import { ToastProvider } from '@providers/toast/toast';

import { Transaction, TranslatableObject, BlocksEpochResponse } from '@models/model';

import * as arkts from 'ark-ts';
import lodash from 'lodash';
import moment from 'moment';
import * as constants from '@app/app.constants';
import arktsConfig from 'ark-ts/config';
import { ArkUtility } from '../../utils/ark-utility';
import { Delegate } from 'ark-ts';
import { StoredNetwork, FeeStatistic } from '@models/stored-network';

interface NodeConfigurationResponse {
  data: {
    feeStatistics: FeeStatistic[]
  };
}

@Injectable()
export class ArkApiProvider {

  public onUpdatePeer$: Subject<arkts.Peer> = new Subject<arkts.Peer>();
  public onUpdateDelegates$: Subject<arkts.Delegate[]> = new Subject<arkts.Delegate[]>();
  public onSendTransaction$: Subject<arkts.Transaction> = new Subject<arkts.Transaction>();

  private _network: StoredNetwork;
  private _api: arkts.Client;

  private _fees: arkts.Fees;
  private _delegates: arkts.Delegate[];

  public arkjs = require('arkjs');

  constructor(
    private httpClient: HttpClient,
    private userDataProvider: UserDataProvider,
    private storageProvider: StorageProvider,
    private toastProvider: ToastProvider,
    private http: HttpClient) {
    this.loadData();

    this.userDataProvider.onActivateNetwork$.subscribe((network) => {

      if (lodash.isEmpty(network)) { return; }

      // set default peer
      if (network && !network.activePeer) {
        network.activePeer = arkts.Network.getDefault(network.type).activePeer;
      }

      this._network = network;
      this.arkjs.crypto.setNetworkVersion(this._network.version);

      this._api = new arkts.Client(this._network);
      this.findGoodPeer();
    });
  }

  public get network() {
    return this._network;
  }

  public get api() {
    return this._api;
  }

  public get feeStatistics () {
    if (!lodash.isUndefined(this._network.feeStatistics)) { return Observable.of(this._network.feeStatistics); }

    return this.fetchFeeStatistics();
  }

  public get fees() {
    if (!lodash.isUndefined(this._fees)) { return Observable.of(this._fees); }

    return this.fetchFees();
  }

  public get delegates(): Observable<arkts.Delegate[]> {
    if (!lodash.isEmpty(this._delegates)) { return Observable.of(this._delegates); }

    return this.fetchDelegates(constants.NUM_ACTIVE_DELEGATES * 2);
  }

  public setNetwork(network: StoredNetwork) {
    // set default peer
    if (network.type !== null) {
      const activePeer = network.activePeer;
      const apiNetwork = arkts.Network.getDefault(network.type);
      if (apiNetwork) {
        network = Object.assign<StoredNetwork, arkts.Network>(network, apiNetwork);
      }
      if (activePeer) {
        network.activePeer = activePeer;
      }
    }

    this._network = network;
    this.arkjs.crypto.setNetworkVersion(this._network.version);

    this._api = new arkts.Client(this._network);
    this.findGoodPeer();

    // Fallback if the fetchEpoch fail
    this._network.epoch = arktsConfig.blockchain.date;
    this.userDataProvider.onUpdateNetwork$.next(this._network);

    this.fetchFees().subscribe();
    this.fetchEpoch().subscribe();
  }

  public async findGoodPeer() {
    // Get list from active peer
    this._api.peer.list().subscribe((response) => {
        if (response && this.findGoodPeerFromList(response.peers)) {
          return;
        } else {
          this.tryGetFallbackPeer();
        }
      },
      () => this.tryGetFallbackPeer());
  }

  private tryGetFallbackPeer() {
    if (this.findGoodPeerFromList(this.network.peerList)) {
      return;
    }

    // Custom network
    if (!this.network.type) {
      return;
    }

    // try get a peer from the hardcoded ark-ts peerlist (only works for main and devnet)
    /*arkts.PeerApi
      .findGoodPeer(this._network)
      .subscribe((peer) => this.updateNetwork(peer),
        () => this.toastProvider.error('API.PEER_LIST_ERROR'));*/
  }

  private findGoodPeerFromList(peerList: arkts.Peer[]): boolean {
    if (!peerList || !peerList.length) {
      return false;
    }
    const filteredPeers = lodash.filter(peerList, (peer) => {
      return peer['status'] === 'OK' && peer.ip !== this._network.activePeer.ip && peer.ip !== '127.0.0.1';
    });

    let filteredPeers = [];
    if (!this._network.isV2) {
      filteredPeers = preFilteredPeers;
    } else {
      const configChecks = [];
      for (const peer of preFilteredPeers) {
        configChecks.push(this._api.peer.getVersion2Config(peer.ip, peer.port).toPromise());
      }

      const peerConfigResponses = await Promise.all(configChecks.map(p => p.catch(e => e)));
      for (const peerId in peerConfigResponses) {
        const config = peerConfigResponses[peerId];
        if (config && config.data) {
          const apiConfig: any = lodash.find(config.data.plugins, (_, key) => key.split('/').reverse()[0] === 'core-api');
          if (apiConfig && apiConfig.enabled && apiConfig.port) {
            const peer = preFilteredPeers[peerId];
            peer.port = apiConfig.port;
            filteredPeers.push(peer);
          }
        }
      }
    }

    const missingHeights = [];
    const missingHeightRequests = [];
    for (const peerId in filteredPeers) {
      const peer = filteredPeers[peerId];
      if (!peer.height) {
        missingHeights.push({
          id: peerId,
          peer
        });
        missingHeightRequests.push(this._api.loader.synchronisationStatus(`http://${peer.ip}:${peer.port}`).toPromise());
      }
    }

    if (missingHeightRequests.length) {
      const missingHeightResponses = await Promise.all(missingHeightRequests.map(p => p.catch(e => e)));
      for (const peerId in missingHeightResponses) {
        const response = missingHeightResponses[peerId];
        if (response && response.height) {
          const missingHeight = missingHeights[peerId];
          const peer = missingHeight.peer;
          peer.height = response.height;
          filteredPeers[missingHeight.peerId] = peer;
        }
      }
    }

    const sortedPeers = lodash.orderBy(filteredPeers, ['height', 'delay'], ['desc', 'asc']);
    if (!sortedPeers.length) {
      return false;
    }
    this._network.peerList = sortedPeers;
    this.updateNetwork(sortedPeers[0]);
    return true;
  }

  public fetchDelegates(numberDelegatesToGet: number, getAllDelegates = false): Observable<arkts.Delegate[]> {
    if (!this._api) { return; }
    const limit = 51;

    const totalCount = limit;
    let offset, currentPage;
    offset = currentPage = 0;

    let totalPages = totalCount / limit;

    let delegates: arkts.Delegate[] = [];

    return Observable.create((observer) => {

      this._api.delegate.list({ limit, offset }).expand(() => {
        const req = this._api.delegate.list({ limit, offset });
        return currentPage < totalPages ? req : Observable.empty();
      }).do((response) => {
        offset += limit;
        if (response.success && getAllDelegates) { numberDelegatesToGet = response.totalCount; }
        totalPages = Math.ceil(numberDelegatesToGet / limit);
        currentPage++;
      }).finally(() => {
        this.storageProvider.set(constants.STORAGE_DELEGATES, delegates);
        this.onUpdateDelegates$.next(delegates);

        observer.next(delegates);
        observer.complete();
      }).subscribe((data) => {
        if (data.success) { delegates = [...delegates, ...data.delegates]; }
      });
    });

  }

  public createTransaction(transaction: Transaction, key: string, secondKey: string, secondPassphrase: string): Observable<Transaction> {
    return Observable.create((observer) => {
      const configNetwork = arktsConfig.networks[this._network.name];
      let jsNetwork;
      if (configNetwork) {
        jsNetwork = {
          messagePrefix: configNetwork.name,
          bip32: configNetwork.bip32,
          pubKeyHash: configNetwork.version,
          wif: configNetwork.wif,
        };
      }

      if (!arkts.PublicKey.validateAddress(transaction.address, this._network)) {
        observer.error({
          key: 'API.DESTINATION_ADDRESS_ERROR',
          parameters: {address: transaction.address}
        } as TranslatableObject);
        return observer.complete();
      }

      const wallet = this.userDataProvider.getWalletByAddress(transaction.address);
      transaction.senderId = transaction.address;

      const totalAmount = transaction.getAmount();
      const balance = Number(wallet.balance);
      if (totalAmount > balance) {
        this.toastProvider.error('API.BALANCE_TOO_LOW');
        observer.error({
          key: 'API.BALANCE_TOO_LOW_DETAIL',
          parameters: {
            token: this._network.token,
            fee: ArkUtility.arktoshiToArk(transaction.fee),
            amount: ArkUtility.arktoshiToArk(transaction.amount),
            totalAmount: ArkUtility.arktoshiToArk(totalAmount),
            balance: ArkUtility.arktoshiToArk(balance)
          }
        } as TranslatableObject);
        return observer.complete();
      }

      const epochTime = moment(this._network.epoch).utc().valueOf();
      const now = moment().valueOf();
      transaction.timestamp = Math.floor((now - epochTime) / 1000);

      transaction.signature = null;
      transaction.id = null;

      const keys = this.arkjs.crypto.getKeys(key, jsNetwork);
      this.arkjs.crypto.sign(transaction, keys);

      secondPassphrase = secondKey || secondPassphrase;

      if (secondPassphrase) {
        const secondKeys = this.arkjs.crypto.getKeys(secondPassphrase, jsNetwork);
        this.arkjs.crypto.secondSign(transaction, secondKeys);
      }

      transaction.id = this.arkjs.crypto.getId(transaction);

      observer.next(transaction);
      observer.complete();
    });
  }

  public postTransaction(transaction: arkts.Transaction, peer: arkts.Peer = this._network.activePeer, broadcast: boolean = true) {
    return Observable.create((observer) => {
      const compressTransaction = JSON.parse(JSON.stringify(transaction));
      this._api.transaction.post(compressTransaction, peer).subscribe((result: arkts.TransactionPostResponse) => {
        if (this.isSuccessfulResponse(result)) {
          this.onSendTransaction$.next(transaction);

          if (broadcast) {
            if (!this._network.isV2) {
              this.broadcastTransaction(transaction);
            }
          }

          observer.next(transaction);
          if (this._network.isV2 && !result.data.accept.length && result.data.broadcast.length) {
            this.toastProvider.warn('TRANSACTIONS_PAGE.WARNING.BROADCAST');
          }
        } else {
          if (broadcast) {
            this.toastProvider.error('API.TRANSACTION_FAILED');
          }
          observer.error(result);
        }
      }, (error) => observer.error(error));
    });

  }

  public getDelegateByPublicKey(publicKey: string): Observable<Delegate> {
    if (!publicKey) {
      return Observable.of(null);
    }

    return this.api
               .delegate
               .get({publicKey: publicKey})
               .map(response => response && response.success ? response.delegate : null);
  }


  private isSuccessfulResponse (response) {
    if (!this._network.isV2) {
      return response.success && response.transactionIds;
    } else {
      const { data, errors } = response;
      return data && data.invalid.length === 0 && errors === null;
    }
  }

  private broadcastTransaction(transaction: arkts.Transaction) {
    const max = 10;

    for (const peer of this.network.peerList.slice(0, max)) {
      this.postTransaction(transaction, peer, false).subscribe();
    }
  }

  private updateNetwork(peer?: arkts.Peer): void {
    if (peer) {
      this._network.setPeer(peer);
      this.onUpdatePeer$.next(peer);
    }
    // Save in localStorage
    this.userDataProvider.addOrUpdateNetwork(this._network, this.userDataProvider.currentProfile.networkId);
    this._api = new arkts.Client(this._network);

    this.fetchDelegates(constants.NUM_ACTIVE_DELEGATES * 2).subscribe((data) => {
      this._delegates = data;
    });

    this.fetchFees().subscribe();
    this.fetchFeeStatistics().subscribe();
  }

  private fetchFeeStatistics(): Observable<FeeStatistic[]> {
    if (!this._network || !this._network.isV2) {
      return Observable.empty();
    }

    return Observable.create((observer) => {
      this.httpClient.get(`${this._network.getPeerAPIUrl()}/api/v2/node/configuration`).subscribe((response: NodeConfigurationResponse) => {
        const data = response.data;
        this._network.feeStatistics = data.feeStatistics;
        observer.next(this._network.feeStatistics);
      }, e => observer.error(e));
    });
  }

  private fetchEpoch(): Observable<BlocksEpochResponse> {
    return this.httpClient.get(`${this._network.getPeerAPIUrl()}/api/blocks/getEpoch`).map((response: BlocksEpochResponse) => {
      this._network.epoch = new Date(response.epoch);
      this.userDataProvider.onUpdateNetwork$.next(this._network);
      return response;
    });
  }

  private fetchFees(): Observable<arkts.Fees> {
    return Observable.create((observer) => {
      arkts.BlockApi.networkFees(this._network).subscribe((response) => {
        if (response && response.success) {
          this._fees = response.fees;
          this.storageProvider.set(constants.STORAGE_FEES, this._fees);

          observer.next(this._fees);
        }
      }, () => {
        observer.next(this.storageProvider.getObject(constants.STORAGE_FEES));
      });
    });
  }

  private loadData() {
    this.storageProvider.getObject(constants.STORAGE_DELEGATES).subscribe((delegates) => this._delegates = delegates);
  }

}