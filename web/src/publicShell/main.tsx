import "@fontsource-variable/geist";
import "@fontsource-variable/fraunces";
import React from "react";
import ReactDOM from "react-dom/client";
import { createRootRoute, createRoute, createRouter,
  Outlet, RouterProvider } from "@tanstack/react-router";

import { AboutPage, HomePage, PrivacyPage } from "./pages";
import "../tokens.css";
import "./shell.css";

const root = createRootRoute({ component: Outlet,
  notFoundComponent: () => <p>That page is not part of this public preview.</p> });
const route = (path: string, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => root, path, component });
const router = createRouter({ routeTree: root.addChildren([
  route("/", HomePage), route("/about", AboutPage),
  route("/privacy", PrivacyPage),
]) });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><RouterProvider router={router} /></React.StrictMode>,
);
