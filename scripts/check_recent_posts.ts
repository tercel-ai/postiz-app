import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

const prisma = new PrismaClient();

async function main() {
  const since = dayjs.utc().subtract(2, 'days').toDate();
  console.log('Fetching recent posts since', since.toISOString());

  const posts = await prisma.post.findMany({
    where: {
      OR: [
        { createdAt: { gte: since } },
        { updatedAt: { gte: since } },
        { publishDate: { gte: since } }
      ]
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
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  console.log(`Found ${posts.length} posts.`);
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
