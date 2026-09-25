import "@fontsource-variable/geist";
import "@fontsource-variable/fraunces";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router";
import { PreviewBanner } from "./PreviewBanner";
import "./tokens.css";
import "./styles.css";
import "./ui/ui.css";
import "./editorial.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PreviewBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
