import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4')
  metricsText(): string {
    return this.metrics.render();
  }
}
