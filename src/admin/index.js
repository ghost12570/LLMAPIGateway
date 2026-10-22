import { registerDashboardRoutes } from './dashboard.js';
import { registerChannelRoutes } from './channels.js';
import { registerModelRoutes } from './models.js';
import { registerUserRoutes } from './users.js';
import { registerKeyRoutes } from './keys.js';
import { registerReportRoutes } from './reports.js';
import { registerSettingsRoutes } from './settings.js';

export function registerAdminRoutes(router, app) {
  registerDashboardRoutes(router, app);
  registerChannelRoutes(router, app);
  registerModelRoutes(router, app);
  registerUserRoutes(router, app);
  registerKeyRoutes(router, app);
  registerReportRoutes(router, app);
  registerSettingsRoutes(router, app);
}
