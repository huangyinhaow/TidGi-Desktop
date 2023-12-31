import useObservable from 'beautiful-react-hooks/useObservable';
import { useState } from 'react';
import { IPage } from './interface';

export function usePagesListObservable(): IPage[] | undefined {
  const [pages, pagesSetter] = useState<IPage[] | undefined>();
  useObservable(window.observables.pages.pages$, (newPages: IPage[]) => {
    pagesSetter(newPages.sort((a, b) => a.order - b.order));
  });
  return pages;
}
