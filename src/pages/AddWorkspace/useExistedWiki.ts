/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callWikiInitialization } from './useCallWikiInitialization';
import { IErrorInWhichComponent, IWikiWorkspaceForm, workspaceConfigFromForm } from './useForm';

export function useValidateExistedWiki(
  isCreateMainWorkspace: boolean,
  isCreateSyncedWorkspace: boolean,
  form: IWikiWorkspaceForm,
  errorInWhichComponentSetter: (errors: IErrorInWhichComponent) => void,
): [boolean, string | undefined, (m: string) => void, (m: boolean) => void] {
  const { t } = useTranslation();
  const [wikiCreationMessage, wikiCreationMessageSetter] = useState<string | undefined>();
  const [hasError, hasErrorSetter] = useState<boolean>(false);
  useEffect(() => {
    if (!form.wikiFolderLocation) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.ExistedWikiLocation')}`);
      errorInWhichComponentSetter({ wikiFolderLocation: true });
      hasErrorSetter(true);
    } else if (isCreateSyncedWorkspace && !form.gitRepoUrl) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.GitRepoUrl')}`);
      errorInWhichComponentSetter({ gitRepoUrl: true });
      hasErrorSetter(true);
    } else if (!isCreateMainWorkspace && !form.mainWikiToLink?.wikiFolderLocation) {
      wikiCreationMessageSetter(`${t('AddWorkspace.NotFilled')}：${t('AddWorkspace.MainWorkspace')}`);
      errorInWhichComponentSetter({ mainWikiToLink: true });
      hasErrorSetter(true);
    } else if (isCreateSyncedWorkspace && (form.gitUserInfo === undefined || !(form.gitUserInfo.accessToken?.length > 0))) {
      wikiCreationMessageSetter(t('AddWorkspace.NotLoggedIn'));
      errorInWhichComponentSetter({ gitUserInfo: true });
      hasErrorSetter(true);
    } else {
      wikiCreationMessageSetter('');
      errorInWhichComponentSetter({});
      hasErrorSetter(false);
    }
  }, [
    t,
    isCreateMainWorkspace,
    isCreateSyncedWorkspace,
    form.wikiFolderLocation,
    form.wikiFolderName,
    form.gitRepoUrl,
    form.gitUserInfo,
    form.mainWikiToLink?.wikiFolderLocation,
    form.tagName,
    errorInWhichComponentSetter,
  ]);
  return [hasError, wikiCreationMessage, wikiCreationMessageSetter, hasErrorSetter];
}
export function useExistedWiki(
  isCreateMainWorkspace: boolean,
  isCreateSyncedWorkspace: boolean,
  form: IWikiWorkspaceForm,
  wikiCreationMessageSetter: (m: string) => void,
  hasErrorSetter: (m: boolean) => void,
): () => Promise<void> {
  const { t } = useTranslation();

  const onSubmit = useCallback(async () => {
    wikiCreationMessageSetter(t('AddWorkspace.Processing'));
    const newWorkspaceConfig = workspaceConfigFromForm(form, isCreateMainWorkspace, isCreateSyncedWorkspace);
    try {
      if (isCreateMainWorkspace) {
        await window.service.wiki.ensureWikiExist(form.wikiFolderLocation, true);
      } else {
        const wikiFolderNameForExistedFolder = window.remote.getBaseName(form.wikiFolderLocation);
        const parentFolderLocationForExistedFolder = window.remote.getDirectoryName(form.wikiFolderLocation);
        if (!wikiFolderNameForExistedFolder || !parentFolderLocationForExistedFolder) {
          throw new Error(
            `Undefined folder name: parentFolderLocationForExistedFolder: ${
              parentFolderLocationForExistedFolder ?? '-'
            }, parentFolderLocationForExistedFolder: ${parentFolderLocationForExistedFolder ?? '-'}`,
          );
        }
        await window.service.wiki.ensureWikiExist(form.wikiFolderLocation, false);
        await window.service.wiki.createSubWiki(
          parentFolderLocationForExistedFolder,
          wikiFolderNameForExistedFolder,
          form.mainWikiToLink?.wikiFolderLocation,
          form.tagName,
          true,
        );
      }
      await callWikiInitialization(newWorkspaceConfig, wikiCreationMessageSetter, t, form.gitUserInfo);
    } catch (error) {
      wikiCreationMessageSetter((error as Error).message);
      hasErrorSetter(true);
    }
  }, [form, wikiCreationMessageSetter, t, isCreateMainWorkspace, isCreateSyncedWorkspace, hasErrorSetter]);

  return onSubmit;
}
