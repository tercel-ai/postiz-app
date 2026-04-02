import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

const prisma = new PrismaClient();

async function main() {
  const today = dayjs.utc().startOf('day').toDate();
  console.log('Checking posts deleted today:', today.toISOString());

  // @ts-ignore
  const posts = await prisma.post.findMany({
    where: {
      deletedAt: { gte: today }
    },
    select: {
      id: true,
      state: true,
      group: true,
      publishDate: true,
      createdAt: true,
      deletedAt: true,
      releaseURL: true,
      content: true,
      integration: {
        select: {
          providerIdentifier: true,
          name: true
        }
      }
    },
    orderBy: { deletedAt: 'desc' }
  });

  console.log(`Found ${posts.length} deleted posts.`);
  for (const post of posts) {
    console.log(`ID: ${post.id}`);
    console.log(`  State: ${post.state}`);
    console.log(`  Group: ${post.group}`);
    console.log(`  CreatedAt: ${post.createdAt.toISOString()}`);
    console.log(`  DeletedAt: ${post.deletedAt}`);
    console.log(`  Integration: ${post.integration?.providerIdentifier} (${post.integration?.name})`);
    console.log(`  Content: ${post.content?.substring(0, 30)}...`);
    console.log('---');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
