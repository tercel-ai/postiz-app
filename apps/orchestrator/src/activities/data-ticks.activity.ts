import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { DataTicksService } from '@gitroom/nestjs-libraries/database/prisma/data-ticks/data-ticks.service';

@Injectable()
@Activity()
export class DataTicksActivity {
  constructor(private _dataTicksService: DataTicksService) {}

  @ActivityMethod()
  async syncDailyTicks(targetDate?: string) {
    const date = targetDate ? new Date(targetDate) : undefined;
    return this._dataTicksService.syncDailyTicks(date);
  }
}
