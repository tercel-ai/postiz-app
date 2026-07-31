'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { HackernewsSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/hackernews.settings.dto';
import { Input } from '@gitroom/react/form/input';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';

// A Hacker News submission needs a title (the story headline); the post content
// is the item text. Publishing itself happens through the browser extension.
const HackernewsSettings: FC = () => {
  const form = useSettings();
  return <Input label="Title" {...form.register('title')} />;
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
