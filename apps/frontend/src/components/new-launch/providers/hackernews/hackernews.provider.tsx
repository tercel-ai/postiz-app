'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { HackernewsSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/hackernews.settings.dto';
import { Input } from '@gitroom/react/form/input';
import { Canonical } from '@gitroom/react/form/canonical';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { useIntegration } from '@gitroom/frontend/components/launches/helpers/use.integration';

// A Hacker News submission needs a title (the story headline); the post content
// is the item text. Publishing itself happens through the browser extension.
// `url` is optional: set it to submit a link post (e.g. operation-plan-generated
// drafts point it at the project's own product URL); leave it empty for a plain
// text post.
const HackernewsSettings: FC = () => {
  const form = useSettings();
  const { date } = useIntegration();
  return (
    <>
      <Input label="Title" {...form.register('title')} />
      <Canonical date={date} label="Link URL" {...form.register('url')} />
    </>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: HackernewsSettings,
  CustomPreviewComponent: undefined,
  dto: HackernewsSettingsDto,
  checkValidity: undefined,
  maximumCharacters: 20000,
});
