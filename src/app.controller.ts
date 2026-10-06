import { Controller, Get } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

@Controller()
export class AppController {

  @Get('test.html')
  getChat(): Promise<string> {
    return readFile(join(process.cwd(), 'test', 'test.html'), 'utf8');
  }
}
