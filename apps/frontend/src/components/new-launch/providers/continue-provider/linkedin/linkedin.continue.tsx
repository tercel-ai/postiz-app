'use client';

import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import { useIntegration } from '@gitroom/frontend/components/launches/helpers/use.integration';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export const LinkedinContinue: FC<{
  onSave: (data: any) => Promise<void>;
  existingId: string[];
  onClose?: () => void;
}> = (props) => {
  const { onSave, existingId } = props; // onClose available but not needed — cleanup is in continue.provider.tsx
  const t = useT();
  const fetchApi = useFetch();
  const { integration } = useIntegration();
  const deletedRef = useRef(false);

  const call = useCustomProviderFunction();
  const [page, setSelectedPage] = useState<null | {
    id: string;
    pageId: string;
  }>(null);
  const loadPages = useCallback(async () => {
    try {
      const pages = await call.get('companies');
      return pages ?? [];
    } catch (e) {
      // Return undefined so SWR treats it as an error —
      // we only auto-delete when we get an explicit empty array.
      return undefined;
    }
  }, []);
  const setPage = useCallback(
    (param: { id: string; pageId: string }) => () => {
      setSelectedPage(param);
    },
    []
  );
  const { data, isLoading } = useSWR('load-pages', loadPages, {
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    revalidateOnReconnect: false,
    refreshInterval: 0,
  });
  const saveLinkedin = useCallback(async () => {
    await onSave({ page: page?.id });
  }, [onSave, page]);
  const filteredData = useMemo(() => {
    return (
      data?.filter((p: { id: string }) => !existingId.includes(p.id)) || []
    );
  }, [data]);

  // No company pages found — immediately delete the temporary
  // inBetweenSteps integration in the background while the user
  // reads the explanation message.
  // Only trigger when data is an explicit empty array (not undefined
  // from a network error) to avoid deleting on transient failures.
  const noPages = !isLoading && Array.isArray(data) && data.length === 0;

  useEffect(() => {
    if (noPages && !deletedRef.current) {
      deletedRef.current = true;
      fetchApi('/integrations/', {
        method: 'DELETE',
        body: JSON.stringify({ id: integration.id }),
      }).catch(() => {});
    }
  }, [noPages]);

  if (noPages) {
    return (
      <div className="text-center flex justify-center items-center text-[18px] leading-[50px] h-[300px]">
        {t(
          'no_linkedin_page_found',
          "No LinkedIn Company Page found for your account."
        )}
        <br />
        {t(
          'use_linkedin_personal_instead',
          'To post as yourself, please close this dialog and add a "LinkedIn" (personal) channel instead.'
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[20px]">
      <div>{t('select_linkedin_page', 'Select Linkedin Page:')}</div>
      <div className="grid grid-cols-3 justify-items-center select-none cursor-pointer">
        {filteredData?.map(
          (p: {
            id: string;
            pageId: string;
            username: string;
            name: string;
            picture: string;
          }) => (
            <div
              key={p.id}
              className={clsx(
                'flex flex-col w-full text-center gap-[10px] border border-input p-[10px] hover:bg-seventh',
                page?.id === p.id && 'bg-seventh'
              )}
              onClick={setPage(p)}
            >
              <div>
                <img className="w-full" src={p.picture} alt="profile" />
              </div>
              <div>{p.name}</div>
            </div>
          )
        )}
      </div>
      <div>
        <Button disabled={!page} onClick={saveLinkedin}>
          {t('save', 'Save')}
        </Button>
      </div>
    </div>
  );
};
