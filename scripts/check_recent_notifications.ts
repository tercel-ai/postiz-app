import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

const prisma = new PrismaClient();

async function main() {
  const today = dayjs.utc().startOf('day').toDate();
  console.log('Checking notifications today:', today.toISOString());

  const notifications = await prisma.notifications.findMany({
    where: {
      createdAt: { gte: today }
    },
    orderBy: { createdAt: 'desc' }
  });

  console.log(`Found ${notifications.length} notifications today.`);
  for (const n of notifications) {
    console.log(`ID: ${n.id}`);
    console.log(`  CreatedAt: ${n.createdAt.toISOString()}`);
    console.log(`  Content: ${n.content}`);
    console.log('---');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
