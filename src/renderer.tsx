/* eslint-disable promise/always-return */
import React from 'react';
import ReactDOM from 'react-dom';
import { Provider } from 'react-redux';

import CssBaseline from '@material-ui/core/CssBaseline';
import { I18nextProvider } from 'react-i18next';
import { WindowNames } from '@/services/windows/WindowProperties';

import 'typeface-roboto/index.css';

import store from './state';
import { init as initDialogCodeInjection } from './state/dialog-code-injection/actions';
import { init as initDialogCustomUserAgent } from './state/dialog-custom-user-agent/actions';
import { init as initDialogEditWorkspace } from './state/dialog-edit-workspace/actions';
import { init as initDialogProxy } from './state/dialog-proxy/actions';
import { init as initDialogSpellcheckLanguages } from './state/dialog-spellcheck-languages/actions';

import index18n from './i18n';

import AppWrapper from './components/app-wrapper';

import getWorkspacesAsList from './helpers/get-workspaces-as-list';

const DialogAbout = React.lazy(async () => await import('./components/dialog-about'));
const DialogAddWorkspace = React.lazy(async () => await import('./components/dialog-add-workspace'));
const DialogAuth = React.lazy(async () => await import('./components/dialog-auth'));
const DialogCodeInjection = React.lazy(async () => await import('./components/dialog-code-injection'));
const DialogCustomUserAgent = React.lazy(async () => await import('./components/dialog-custom-user-agent'));
const DialogDisplayMedia = React.lazy(async () => await import('./components/dialog-display-media'));
const DialogEditWorkspace = React.lazy(async () => await import('./components/dialog-edit-workspace'));
const DialogGoToUrl = React.lazy(async () => await import('./components/dialog-go-to-url'));
const DialogNotifications = React.lazy(async () => await import('./components/dialog-notifications'));
const DialogOpenUrlWith = React.lazy(async () => await import('./components/dialog-open-url-with'));
const DialogPreferences = React.lazy(async () => await import('./components/dialog-preferences'));
const DialogProxy = React.lazy(async () => await import('./components/dialog-proxy'));
const DialogSpellcheckLanguages = React.lazy(async () => await import('./components/dialog-spellcheck-languages'));
const Main = React.lazy(async () => await import('./components/main'));

declare global {
  interface Window {
    meta: {
      windowName: string;
    };
    remote: any;
    preventClosingWindow: boolean;
  }
}

const App = (): JSX.Element => {
  switch (window.meta.windowName) {
    case WindowNames.about:
      document.title = 'About';
      return <DialogAbout />;
      document.title = 'Add Workspace';
    case WindowNames.addWorkspace:
      document.title = 'Add Workspace';
      return <DialogAddWorkspace />;
    case WindowNames.auth:
      document.title = 'Sign In';
      return <DialogAuth />;
    case WindowNames.codeInjection:
      return <DialogCodeInjection />;
    case WindowNames.userAgent:
      return <DialogCustomUserAgent />;
    case WindowNames.displayMedia:
      document.title = 'Share your Screen';
      return <DialogDisplayMedia />;
    case WindowNames.editWorkspace:
      return <DialogEditWorkspace />;
    case WindowNames.goToUrl:
      document.title = 'Go to URL';
      return <DialogGoToUrl />;
    case WindowNames.notifications:
      document.title = 'Notifications';
      return <DialogNotifications />;
    case WindowNames.openUrlWith:
      document.title = 'Open Link With';
      return <DialogOpenUrlWith />;
    case WindowNames.preferences:
      document.title = 'Preferences';
      return <DialogPreferences />;
    case WindowNames.proxy:
      return <DialogProxy />;
    case WindowNames.spellcheck:
      return <DialogSpellcheckLanguages />;
    default:
      document.title = 'TiddlyGit';
      return <Main />;
  }
};

const runApp = (): void => {
  Promise.resolve()
    .then(() => {
      window.remote.webFrame.setVisualZoomLevelLimits(1, 1);
      if (window.meta.windowName === WindowNames.editWorkspace) {
        store.dispatch(initDialogEditWorkspace());
        const { workspaces } = store.getState();
        const workspaceList = getWorkspacesAsList(workspaces);
        const editWorkspaceId = window.remote.getGlobal('editWorkspaceId');
        const workspace = workspaces[editWorkspaceId];
        workspaceList.some((item, index) => {
          // @ts-expect-error ts-migrate(2571) FIXME: Object is of type 'unknown'.
          if (item.id === editWorkspaceId) {
            workspace.order = index;
            return true;
          }
          return false;
        });
        document.title = workspace.name ? `Edit Workspace ${workspace.order + 1} "${workspace.name}"` : `Edit Workspace ${workspace.order + 1}`;
      } else if (window.meta.windowName === 'code-injection') {
        store.dispatch(initDialogCodeInjection());
        const codeInjectionType = window.remote.getGlobal('codeInjectionType');
        document.title = `Edit ${codeInjectionType.toUpperCase()} Code Injection`;
      } else if (window.meta.windowName === 'custom-user-agent') {
        store.dispatch(initDialogCustomUserAgent());
        document.title = 'Edit Custom User Agent';
      } else if (window.meta.windowName === 'proxy') {
        store.dispatch(initDialogProxy());
        document.title = 'Proxy Settings';
      } else if (window.meta.windowName === 'spellcheck-languages') {
        store.dispatch(initDialogSpellcheckLanguages());
        document.title = 'Preferred Spell Checking Languages';
      }

      if (window.meta.windowName !== 'main' && window.meta.windowName !== 'menubar') {
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            if (window.preventClosingWindow) {
              return;
            }
            window.remote.closeCurrentWindow();
          }
        });
      }
    })
    .catch(console.error);

  ReactDOM.render(
    <Provider store={store}>
      <AppWrapper>
        <CssBaseline />
        <React.Suspense fallback={<div />}>
          <I18nextProvider i18n={index18n}>
            <App />
          </I18nextProvider>
        </React.Suspense>
      </AppWrapper>
    </Provider>,
    document.querySelector('#app'),
  );
};

runApp();
