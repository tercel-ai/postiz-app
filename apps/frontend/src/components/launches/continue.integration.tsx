'use client';

import { FC, useEffect, useState } from 'react';
import { HttpStatusCode } from 'axios';
import { useRouter } from 'next/navigation';
import { Redirect } from '@gitroom/frontend/components/layout/redirect';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import dayjs from 'dayjs';

// Module-level so it survives StrictMode's mount→unmount→remount cycle and any
// component re-render. Each OAuth callback is a fresh full-page navigation, so
// this starts empty per flow and holds at most a handful of keys.
const processedAuthCodes = new Set<string>();

export const ContinueIntegration: FC<{
  provider: string;
  searchParams: any;
}> = (props) => {
  const { provider, searchParams } = props;
  const { push } = useRouter();
  const t = useT();
  const fetch = useFetch();
  const [error, setError] = useState(false);

  useEffect(() => {
    // OAuth authorization codes are single-use. React StrictMode (dev) invokes
    // effects twice, and a re-render with a fresh `searchParams` object identity
    // re-fires this effect — both would POST /connect with the same code. The
    // first exchange consumes the code; the second hits the provider with an
    // already-redeemed code and is rejected (e.g. Reddit returns HTTP 403). The
    // backend's sequential state guard doesn't catch a concurrent double-fire, so
    // we dedupe by code here to guarantee exactly one exchange per authorization.
    const dedupeKey = `${provider}:${searchParams?.state ?? ''}:${
      searchParams?.code ?? ''
    }`;
    if (processedAuthCodes.has(dedupeKey)) {
      return;
    }
    processedAuthCodes.add(dedupeKey);

    (async () => {
      const timezone = String(dayjs.tz().utcOffset());
      const modifiedParams = { ...searchParams };

      if (provider === 'vk') {
        Object.assign(modifiedParams, {
          ...searchParams,
          state: searchParams.state || '',
          code: searchParams.code + '&&&&' + searchParams.device_id,
        });
      }

      const data = await fetch(`/integrations/social/${provider}/connect`, {
        method: 'POST',
        body: JSON.stringify({ ...modifiedParams, timezone }),
      });

      if (data.status === HttpStatusCode.PreconditionFailed) {
        push(`/launches?precondition=true`);
        return ;
      }

      if (data.status === HttpStatusCode.NotAcceptable) {
        const { msg } = await data.json();
        push(`/launches?msg=${msg}`);
        return;
      }

      if (
        data.status !== HttpStatusCode.Ok &&
        data.status !== HttpStatusCode.Created
      ) {
        setError(true);
        return;
      }

      const { inBetweenSteps, id, onboarding: resOnboarding } = await data.json();
      const onboarding = resOnboarding || searchParams.onboarding === 'true';
      if (inBetweenSteps && !searchParams.refresh) {
        push(`/launches?added=${provider}&continue=${id}${onboarding ? '&onboarding=true' : ''}`);
        return;
      }
      push(`/launches?added=${provider}&msg=Channel Updated${onboarding ? '&onboarding=true' : ''}`);
    })();
  }, [provider, searchParams]);

  return error ? (
    <>
      <div className="mt-[50px] text-[50px]">
        {t('could_not_add_provider', 'Could not add provider.')}
        <br />
        {t('you_are_being_redirected_back', 'You are being redirected back')}
      </div>
      <Redirect url="/launches" delay={3000} />
    </>
  ) : null;
};
