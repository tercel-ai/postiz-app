'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { LinkedinDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/linkedin.dto';
import { LinkedinPreview } from '@gitroom/frontend/components/new-launch/providers/linkedin/linkedin.preview';

const LinkedInSettings = () => {
  const t = useT();
  const { register } = useSettings();

  return (
    <div className="mb-[20px] flex flex-col gap-[12px]">
      <Checkbox
        variant="hollow"
        label={t('post_as_images_carousel', 'Post as images carousel')}
        {...register('post_as_images_carousel', {
          value: false,
        })}
      />
      <Select
        label={t('visibility', 'Who can see your post')}
        name="visibility"
        extraForm={{ value: 'PUBLIC' }}
      >
        <option value="PUBLIC">{t('visibility_public', 'Anyone')}</option>
        <option value="CONNECTIONS">{t('visibility_connections', 'Connections only')}</option>
        <option value="LOGGED_IN">{t('visibility_logged_in', 'LinkedIn members only')}</option>
      </Select>
      <Checkbox
        variant="hollow"
        label={t('disable_comments', 'Disable comments')}
        {...register('disable_comments', {
          value: false,
        })}
      />
      <Input
        label={t('reshare_url', 'Reshare Post URL')}
        placeholder="https://www.linkedin.com/feed/update/urn:li:activity:1234567890"
        {...register('reshare_url')}
      />
    </div>
  );
};
export default withProvider<LinkedinDto>({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: LinkedInSettings,
  CustomPreviewComponent: LinkedinPreview,
  dto: LinkedinDto,
  checkValidity: async (posts, vals) => {
    const [firstPost, ...restPosts] = posts ?? [];

    if (
      vals?.post_as_images_carousel &&
      ((firstPost?.length ?? 0) < 2 ||
        firstPost?.some((p) => (p?.path?.indexOf?.('mp4') ?? -1) > -1))
    ) {
      return 'Carousel can only be created with 2 or more images and no videos.';
    }

    if (
      (firstPost?.length ?? 0) > 1 &&
      firstPost?.some((p) => (p?.path?.indexOf?.('mp4') ?? -1) > -1)
    ) {
      return 'Can have maximum 1 media when selecting a video.';
    }
    if (restPosts?.some((p) => (p?.length ?? 0) > 0)) {
      return 'Comments can only contain text.';
    }
    return true;
  },
  maximumCharacters: 3000,
});
