import BigNumber from 'bignumber.js';
import moment from 'moment';
import { Transaction as TransactionModel, TransactionType } from 'ark-ts/model';

import { MarketCurrency, MarketHistory, MarketTicker } from '@models/market';

import { StoredNetwork } from './stored-network';
import { ArkUtility } from '../utils/ark-utility';

const TX_TYPES = {
  0: 'TRANSACTIONS_PAGE.SENT',
  1: 'TRANSACTIONS_PAGE.SECOND_SIGNATURE_CREATION',
  2: 'TRANSACTIONS_PAGE.DELEGATE_REGISTRATION',
  3: 'DELEGATES_PAGE.VOTE',
  4: 'TRANSACTIONS.MULTISIGNATURE_CREATION',
};

const TX_TYPES_ACTIVITY = {
  0: 'TRANSACTIONS_PAGE.SENT_TO',
  1: 'TRANSACTIONS_PAGE.SECOND_SIGNATURE_CREATION',
  2: 'TRANSACTIONS_PAGE.DELEGATE_REGISTRATION',
  3: 'DELEGATES_PAGE.VOTE',
  4: 'TRANSACTIONS.MULTISIGNATURE_CREATION',
};

export interface SendTransactionForm {
  amount?: number;
  amountEquivalent?: number;
  fee?: number;
  recipientAddress?: string;
  recipientName?: string;
  smartBridge?: string;
}

export class Transaction extends TransactionModel {

  public date: Date;

  constructor(public address: string, private network: StoredNetwork) {
    super();
  }

  deserialize(input: any): Transaction {
    const self: any = this;

    for (const prop in input) {
      self[prop] = input[prop];
    }

    this.date = new Date(this.getTimestamp() * 1000);
    this.amount = new BigNumber(input['amount']).toNumber();
    this.fee = new BigNumber(input['fee']).toNumber();
    delete self.network;

    return self;
  }

  getAmount() {
    let amount = this.amount;

    if (this.isSender()) { amount = this.amount + this.fee; }

    return amount;
  }

  getAmountEquivalent(marketCurrency: MarketCurrency, market: MarketTicker | MarketHistory): number {
    if (!market || !marketCurrency) { return 0; }

    let price = 0;
    if (market instanceof MarketTicker) {
      const currency = market ? market.getCurrency({ code: marketCurrency.code }) : null;
      price = currency ? currency.price : 0;
    } else {
      price = market.getPriceByDate(marketCurrency.code, this.date);

      if (!price) {
        price = market.getPriceByDate(marketCurrency.code, moment(this.date).subtract(1, 'd').toDate());
      }
    }

    const amount = ArkUtility.arktoshiToArk(this.getAmount(), true);
    const raw = amount * price;

    return isNaN(raw) ? 0 : raw;
  }

  getTimestamp() {
    const blockchainTime = new Date(this.network.epoch).getTime() / 1000;

    return this.timestamp + blockchainTime;
  }

  getAppropriateAddress() {
    if (this.isTransfer()) {
      if (this.isSender()) {
        return this.recipientId;
      } else if (this.isReceiver()) {
        return this.senderId;
      }
    }
  }

  getTypeLabel(): string {
    let type = TX_TYPES[this.type];

    if (this.isTransfer() && !this.isSender()) { type = 'TRANSACTIONS_PAGE.RECEIVED'; }

    return type;
  }

  getActivityLabel() {
    let type = TX_TYPES_ACTIVITY[this.type];

    if (this.isTransfer() && !this.isSender()) { type = 'TRANSACTIONS_PAGE.RECEIVED_FROM'; }

    return type;
  }

  isTransfer(): boolean {
    return this.type === TransactionType.SendArk;
  }

  isSender(): boolean {
    return this.senderId === this.address;
  }

  isReceiver(): boolean {
    return this.recipientId === this.address;
  }

}
