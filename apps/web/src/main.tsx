import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UiProvider } from "./state";
import { App } from "./App";
import { Background } from "./Background";
import "@fontsource-variable/onest";
import "@fontsource-variable/unbounded";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}><UiProvider><Background /><BrowserRouter><App /></BrowserRouter></UiProvider></QueryClientProvider>
  </React.StrictMode>,
);
