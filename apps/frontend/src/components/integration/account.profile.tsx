'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import dayjs from 'dayjs';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import copy from 'copy-to-clipboard';
import { useToaster } from '@gitroom/react/toaster/toaster';

export const AccountProfile = ({ id }: { id: string }) => {
  const fetch = useFetch();
  const router = useRouter();
  const t = useT();
  const toaster = useToaster();

  const load = async () => {
    return (await fetch(`/integrations/profile/${id}`)).json();
  };

  const { data, isLoading } = useSWR(`/integrations/profile/${id}`, load);

  if (isLoading) {
    return (
      <div className="flex-1 w-full flex items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }

  if (!data || !data.integration) {
    return (
      <div className="flex-1 w-full flex items-center justify-center">
        {t('not_found', 'Not found')}
      </div>
    );
  }

  const { integration, postsCount, analytics, userEmail } = data;

  const findAnalytic = (label: string) => {
    const item = analytics?.find(
      (a: any) => a.label?.toLowerCase() === label.toLowerCase()
    );
    if (!item || !item.data || !item.data.length) return '--';
    const val = item.data[item.data.length - 1].total;
    return new Intl.NumberFormat('en-US').format(Number(val));
  };

  const copyId = () => {
    copy(integration.internalId);
    toaster.show(t('copied', 'Copied to clipboard'), 'success');
  };

  return (
    <div className="flex-1 w-full bg-newBgColor flex flex-col items-center pb-10">
      <div className="w-full max-w-[500px] mt-[40px]">
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={() => router.back()}
            className="text-textColor flex items-center gap-2 hover:opacity-70 transition-opacity"
          >
            ←
          </button>
          <h1 className="text-2xl font-normal bg-[#FCF8ED] dark:bg-newBgColorInner text-black dark:text-textColor px-[12px] py-[4px] rounded-[8px]">
            {t('account_profile', 'Account Profile')}
          </h1>
        </div>

        <div className="bg-[#FCF8ED] dark:bg-newBgColorInner text-black dark:text-textColor rounded-[16px] p-[24px] shadow-sm">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h2 className="text-[16px] font-[500] mb-4">
                {t('profile', 'Profile')}
              </h2>
              <div className="flex items-center gap-4">
                <ImageWithFallback
                  src={integration.picture || '/no-picture.jpg'}
                  fallbackSrc="/no-picture.jpg"
                  width={64}
                  height={64}
                  className="rounded-full border border-gray-200 dark:border-tableBorder"
                  alt="Profile"
                />
                <div className="flex flex-col gap-[4px]">
                  <div className="text-[18px] font-[500]">
                    {integration.name}
                  </div>
                  <div className="text-gray-500 text-[12px] flex items-center gap-[6px]">
                    {integration.internalId}
                    <svg
                      onClick={copyId}
                      className="cursor-pointer hover:text-black dark:hover:text-white transition-colors"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </div>
                </div>
              </div>
            </div>
            <button className="text-gray-500 hover:text-black dark:hover:text-white">
              ⋮
            </button>
          </div>

          <div className="h-[1px] bg-black/20 dark:bg-white/10 w-full my-6"></div>

          <div className="mb-6">
            <h2 className="text-[16px] font-[500] mb-4">
              {t('data_of_posts', 'Data Of Posts')}
            </h2>
            <div className="flex items-center gap-4 mb-5">
              <span className="text-[12px] text-gray-500">
                {t('platform', 'Platform')}
              </span>
              <span className="flex items-center gap-[6px] bg-red-100/50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-[10px] py-[4px] rounded-full text-[12px] font-medium border border-red-200 dark:border-red-800">
                <img
                  src={`/icons/platforms/${integration.providerIdentifier}.png`}
                  className="w-[14px] h-[14px] rounded-full"
                  alt={integration.providerIdentifier}
                />
                <span className="capitalize">{integration.providerIdentifier}</span>
              </span>
            </div>

            <div className="flex flex-col gap-[14px] text-[14px]">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>📄</span> {t('posts', 'Posts')}
                </div>
                <div className="font-[500]">
                  {new Intl.NumberFormat('en-US').format(postsCount)}
                </div>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>📈</span> {t('impressions', 'Impressions')}
                </div>
                <div className="font-[500]">{findAnalytic('impressions')}</div>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>❤️</span> {t('like', 'like')}
                </div>
                <div className="font-[500]">{findAnalytic('likes')}</div>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>💬</span> {t('replies', 'Replies')}
                </div>
                <div className="font-[500]">{findAnalytic('replies')}</div>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>🔁</span> {t('retweets', 'Retweets')}
                </div>
                <div className="font-[500]">{findAnalytic('retweets')}</div>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>📝</span> {t('quotes', 'Quotes')}
                </div>
                <div className="font-[500]">{findAnalytic('quotes')}</div>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
                  <span>🔖</span> {t('bookmarks', 'Bookmarks')}
                </div>
                <div className="font-[500]">{findAnalytic('bookmarks')}</div>
              </div>
            </div>
          </div>

          <div className="h-[1px] bg-black/20 dark:bg-white/10 w-full my-6"></div>

          <div className="flex items-center gap-3 mb-6 text-[14px] text-gray-600 dark:text-gray-300">
            <span>✉️</span> {userEmail || '--'}
          </div>

          <div className="h-[1px] bg-black/20 dark:bg-white/10 w-full my-6"></div>

          <div>
            <h2 className="text-[16px] font-[500] mb-5">
              {t('personal_information', 'Personal Information')}
            </h2>
            <div className="grid grid-cols-2 gap-y-6 gap-x-8">
              <div>
                <div className="text-[12px] text-gray-500 mb-1">
                  {t('date_of_add', 'Date of Add')}
                </div>
                <div className="font-[500] text-[14px]">
                  {dayjs(integration.createdAt).format('MM/DD/YYYY')}
                </div>
              </div>
              <div>
                <div className="text-[12px] text-gray-500 mb-1">
                  {t('krama', 'Krama')}
                </div>
                <div className="font-[500] text-[14px]">--</div>
              </div>
              <div>
                <div className="text-[12px] text-gray-500 mb-1">
                  {t('nationality', 'Nationality')}
                </div>
                <div className="font-[500] text-[14px]">--</div>
              </div>
              <div>
                <div className="text-[12px] text-gray-500 mb-1">
                  {t('platform_id', 'Platform ID')}
                </div>
                <div className="font-[500] text-[14px] break-all">
                  {integration.internalId}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
