import { Component, Output, EventEmitter } from '@angular/core';
import { ModalController } from 'ionic-angular';
import { QRCodeScheme } from '@models/model';

import lodash from 'lodash';
import bip39 from 'bip39';
import * as constants from '@app/app.constants';

@Component({
  selector: 'qr-scanner',
  templateUrl: 'qr-scanner.html'
})
export class QRScannerComponent {

  @Output('onSuccess') onSuccess: EventEmitter<any> = new EventEmitter();
  @Output('onWrong') onWrong: EventEmitter<void> = new EventEmitter();

  constructor(private modalCtrl: ModalController) { }

  open(format: boolean = false) {
    const modal = this.modalCtrl.create('QRScannerModal');

    modal.onDidDismiss((qrCode) => {
      if (lodash.isNil(qrCode)) { return this.onWrong.emit(); }

      let response = qrCode;

      if (format) { response = this.formatScheme(qrCode); }
      return this.onSuccess.emit(response);
    });

    modal.present();
  }

  private formatScheme(qrCode: any): QRCodeScheme {
    if (lodash.isObject(qrCode)) { return this.formatOld(qrCode); }

    const scheme: QRCodeScheme = {};
    const prefixUriRegex = new RegExp(`${constants.URI_QRCODE_SCHEME_PREFIX}([Oo]{1}[0-9a-zA-Z]{33})`, 'g');

    if (qrCode.match(prefixUriRegex)) {
      scheme.address = prefixUriRegex.exec(qrCode)[1];
      const paramsRegex = new RegExp(`(\\?|\\&)([^=]+)\\=([^&]+)`, 'g');
      let regexResult;
      while ((regexResult = paramsRegex.exec(qrCode)) != null) {
        switch (regexResult[2]) {
          case 'amount':
            scheme.amount = regexResult[3];
            break;
          case 'vendorField':
            scheme.vendorField = regexResult[3];
            break;
          case 'label':
            scheme.label = regexResult[3];
            break;
        }
      }
    } else {
      if (bip39.validateMnemonic(qrCode)) {
        scheme.passphrase = qrCode;
      } else if (qrCode.match(/^[Oo]{1}[0-9a-zA-Z]{33}/g)) {
        scheme.address = qrCode;
      }

      this.onWrong.emit();
    }

    return scheme;
  }

  private formatOld(json): QRCodeScheme {
    const scheme: QRCodeScheme = {};

    if (json['a'] || json['address']) {
      scheme.address = json['a'] || json['address'];
    }

    if (json['p'] || json['passphrase']) {
      scheme.passphrase = json['p'] || json['passphrase'];
    }

    return scheme;
  }

}
