import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

import { LandingPage } from "./App";
import { BackupPage } from "./BackupPage";
import { DesignSystemPage } from "./DesignSystemPage";
import { InformationPage } from "./InformationPage";
import { LoginPage } from "./LoginPage";
import { RecordsPage } from "./RecordsPage";
import { RecoveryPage } from "./RecoveryPage";
import { SetupPage } from "./SetupPage";
import { WorkspacePage } from "./WorkspacePage";

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: LandingPage,
});

const route = (path: string, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const routeTree = rootRoute.addChildren([
  route("/", LandingPage),
  route("/privacy", () => <InformationPage page="privacy" />),
  route("/about", () => <InformationPage page="about" />),
  route("/setup", SetupPage),
  route("/login", LoginPage),
  route("/recover", RecoveryPage),
  route("/records", RecordsPage),
  route("/workspace", WorkspacePage),
  route("/backup", BackupPage),
  route("/design-system", () => import.meta.env.DEV ? <DesignSystemPage /> : <LandingPage />),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
