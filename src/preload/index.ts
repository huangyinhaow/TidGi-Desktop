import 'reflect-metadata';
import { contextBridge, ipcRenderer } from 'electron';
import { IServicesWithoutObservables, IServicesWithOnlyObservables } from 'electron-ipc-cat/common';

import './common/test';
import './common/i18n';
import './common/log';
import './common/remote';
import * as service from './common/services';
import { ViewChannel } from '@/constants/channels';
import { IPossibleWindowMeta } from '@services/windows/WindowProperties';
import { browserViewMetaData } from './common/browserViewMetaData';
import './common/authingPostMessage';
import './view';

contextBridge.exposeInMainWorld('service', service);

declare global {
  interface Window {
    meta: IPossibleWindowMeta;
    observables: IServicesWithOnlyObservables<typeof service>;
    service: IServicesWithoutObservables<typeof service>;
  }
}

if (browserViewMetaData.windowName === 'main') {
  // automatically reload page when wifi/network is connected
  // https://www.electronjs.org/docs/tutorial/online-offline-events
  const handleOnlineOffline = (): void => {
    void ipcRenderer.invoke(ViewChannel.onlineStatusChanged, window.navigator.onLine);
  };
  window.addEventListener('online', handleOnlineOffline);
  window.addEventListener('offline', handleOnlineOffline);
}
