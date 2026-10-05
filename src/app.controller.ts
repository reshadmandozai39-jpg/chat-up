import { Controller, Get } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('test.html')
  getChat(): Promise<string> {
    return readFile(join(process.cwd(), 'test', 'test.html'), 'utf8');
  }
}
