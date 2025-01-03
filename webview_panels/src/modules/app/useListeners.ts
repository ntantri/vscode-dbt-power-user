import { Dispatch, useCallback, useEffect } from "react";
import {
  executeRequestInAsync,
  executeRequestInSync,
  handleIncomingResponse,
} from "./requestExecutor";
import {
  AppStateProps,
  IncomingMessageProps,
  IncomingSyncResponse,
  Themes,
  User,
} from "./types";
import { panelLogger } from "@modules/logger";
import { UnknownAction } from "@reduxjs/toolkit";
import {
  setCurrentUser,
  setTenantInfo,
  setUsers,
  updateTheme,
} from "./appSlice";

const useListeners = (dispatch: Dispatch<UnknownAction>): void => {
  const onMesssage = useCallback(
    (event: MessageEvent<IncomingMessageProps>) => {
      const { command, args } = event.data;
      switch (command) {
        case "response":
          handleIncomingResponse(args as unknown as IncomingSyncResponse);
          break;
        default:
          break;
      }
    },
    [],
  );

  const isDark = (element: HTMLElement) => {
    const classList = element.classList;
    if (classList.contains("vscode-dark")) {
      return true;
    }

    if (classList.contains("vscode-high-contrast-light")) {
      return false;
    }

    if (classList.contains("vscode-high-contrast")) {
      return true;
    }

    return false;
  };
  const setTheme = (element: HTMLElement) => {
    dispatch(updateTheme(isDark(element) ? Themes.Dark : Themes.Light));
  };

  const loadUsersDetails = () => {
    executeRequestInSync("getUsers", {})
      .then((data) => {
        panelLogger.log("getUsers", data);
        dispatch(setUsers(data as User[]));
      })
      .catch((err) =>
        panelLogger.error("error while fetching users list", err),
      );
  };

  const loadCurrentUser = () => {
    executeRequestInSync("getCurrentUser", {})
      .then((data) => {
        panelLogger.log("getCurrentUser", data);
        dispatch(setCurrentUser(data as User));
      })
      .catch((err) =>
        panelLogger.error("error while fetching current user", err),
      );
  };

  const loadTenantInfo = () => {
    executeRequestInSync("fetch", {
      endpoint: "auth/tenant-info",
      fetchArgs: { method: "GET" },
    })
      .then((data) => {
        panelLogger.log("loadTenantInfo", data);
        dispatch(setTenantInfo(data as AppStateProps["tenantInfo"]));
      })
      .catch((err) =>
        panelLogger.error("error while fetching tenant info", err),
      );
  };

  useEffect(() => {
    window.addEventListener("message", onMesssage);

    executeRequestInAsync("webview:ready", {});
    const themeObserver = new MutationObserver((mutations) => {
      mutations.forEach((mu) => {
        panelLogger.debug("body classname modified!", mu);
        setTheme(mu.target as HTMLElement);
      });
    });

    loadUsersDetails();
    loadCurrentUser();
    loadTenantInfo();

    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    setTheme(document.body);

    return () => {
      window.removeEventListener("message", onMesssage);
      themeObserver.disconnect();
    };
  }, [onMesssage]);
};

export default useListeners;
