/* eslint-disable @typescript-eslint/strict-boolean-expressions */
/* eslint-disable @typescript-eslint/promise-function-async */
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';
import is, { isNot } from 'typescript-styled-is';

import { sidebarWidth } from '@/constants/style';
import { usePreferenceObservable } from '@services/preferences/hooks';
import { useWorkspacesListObservable } from '@services/workspaces/hooks';
import FindInPage from '../../components/FindInPage';
import { WikiBackground } from '../WikiBackground';
import { SideBar } from './Sidebar';

const OuterRoot = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
`;

const Root = styled.div`
  display: flex;
  flex-direction: row;
  flex: 1;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background-color: ${({ theme }) => theme.palette.background.default};
  color: ${({ theme }) => theme.palette.text.primary};

  .simplebar-content {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
`;

const ContentRoot = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;

  padding-right: 20px;
  ${is('sidebar')`
    width: calc(100% - ${String(sidebarWidth)}px);
    max-width: calc(100% - ${String(sidebarWidth)}px);
  `}
  ${isNot('sidebar')`
    width: 100%;
    padding-left: 20px;
  `}
  height: 100%;
`;

export default function Main(): JSX.Element {
  const { t } = useTranslation();
  const preferences = usePreferenceObservable();
  if (preferences === undefined) return <div>{t('Loading')}</div>;
  const { sidebar } = preferences;

  return (
    <OuterRoot>
      <div id='test' data-usage='For spectron automating testing' />
      <Helmet>
        <title>{t('Menu.TidGi')}</title>
      </Helmet>
      <Root>
        {sidebar && <SideBar />}
        <ContentRoot sidebar={sidebar}>
          <FindInPage />
          <WikiBackground />
        </ContentRoot>
      </Root>
    </OuterRoot>
  );
}
