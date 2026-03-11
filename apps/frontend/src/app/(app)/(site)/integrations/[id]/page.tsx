export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AccountProfile } from '@gitroom/frontend/components/integration/account.profile';

export const metadata: Metadata = {
  title: 'Account Profile',
  description: '',
};

export default async function Index({ params }: { params: { id: string } }) {
  return <AccountProfile id={params.id} />;
}
