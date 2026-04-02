import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

const prisma = new PrismaClient();

async function main() {
  const today = dayjs.utc().startOf('day').toDate();
  console.log('Checking organizations created today:', today.toISOString());

  const orgs = await prisma.organization.findMany({
    where: {
      createdAt: { gte: today }
    }
  });

  console.log(`Found ${orgs.length} new organizations.`);
  for (const o of orgs) {
    console.log(`ID: ${o.id}`);
    console.log(`  Name: ${o.name}`);
    console.log('---');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
