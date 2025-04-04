import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import {
  Disposable,
  window,
  workspace,
  Uri,
  commands,
  extensions,
} from "vscode";
import { provideSingleton } from "../utils";
import { DBTTerminal } from "../dbt_client/dbtTerminal";
import { DbtPowerUserMcpServerTools } from "./server";
import {
  AltimateRequest,
  DBTProjectContainer,
  TelemetryEvents,
  TelemetryService,
} from "@extension";
import { SharedStateService } from "../services/sharedStateService";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { findAvailablePort, isCursor } from "./utils";
import path from "path";
import { McpPanel } from "../webview_provider/mcpPanel";
import { DataPilotChatParticipant } from "../chat_participants/dataPilot";
import https from "https";
import http from "http";
import fs from "fs";

const PING_INTERVAL = 15000;
@provideSingleton(DbtPowerUserMcpServer)
export class DbtPowerUserMcpServer implements Disposable {
  private disposables: Disposable[] = [];
  private mcpServer: Server | undefined;
  private mcpTransport: SSEServerTransport | undefined;
  private port: number | undefined;
  private isHttps: boolean | undefined;

  constructor(
    private dbtPowerUserMcpServerTools: DbtPowerUserMcpServerTools,
    private dbtTerminal: DBTTerminal,
    private altimate: AltimateRequest,
    private emitterService: SharedStateService,
    private telemetry: TelemetryService,
    private dbtProjectContainer: DBTProjectContainer,
    private dbtChatParticipant: DataPilotChatParticipant,
  ) {
    this.disposables.push(
      emitterService.eventEmitter.event((d) => {
        if (d.command === "dbtProjectsInitialized") {
          this.startOnboarding();
        }
      }),
    );
  }

  private async startOnboarding() {
    this.dbtTerminal.info("DbtPowerUserMcpServer", "Starting onboarding");

    const port = await this.start();
    if (isCursor() && port) {
      await this.updatePortInCursorMcpSettings(port);
    }

    const onboardedMcpServer = workspace
      .getConfiguration("dbt")
      .get<boolean>("onboardedMcpServer", false);

    let ide = "Copilot Chat";
    if (isCursor()) {
      ide = "Cursor";
    }

    const copilotExtension = extensions.getExtension("GitHub.copilot");
    const copilotEnabled = copilotExtension && copilotExtension.isActive;

    if (!onboardedMcpServer && (isCursor() || copilotEnabled)) {
      this.telemetry.sendTelemetryEvent(TelemetryEvents["MCP/Onboarding"], {
        name: "Onboarding",
      });
      const answer = await window.showInformationMessage(
        `${ide} can now leverage dbt Power User features to provide better answers, help you understand and refactor your code, and assess impact of changes more effectively. Ready to set it up?`,
        { modal: false },
        "Set Up Now",
        "Later",
      );

      if (answer === "Set Up Now") {
        if (!this.altimate.handlePreviewFeatures()) {
          this.dbtTerminal.info(
            "DbtPowerUserMcpServer",
            "Preview features are not enabled, skipping MCP server start",
          );
          return;
        }
        await workspace
          .getConfiguration("dbt")
          .update("onboardedMcpServer", true, true);

        this.telemetry.sendTelemetryEvent(
          TelemetryEvents["MCP/Onboarding/SetUpNow"],
        );
        this.showOnboardingSteps();
        return;
      }
      this.telemetry.sendTelemetryEvent(
        TelemetryEvents["MCP/Onboarding/Later"],
      );
    }
  }

  private async showOnboardingSteps() {
    const workspaceFolders = workspace.workspaceFolders;
    if (!workspaceFolders) {
      window.showErrorMessage(
        "Setting up MCP server currently requires opening a workspace",
      );
      return;
    }

    const uri = Uri.joinPath(
      workspaceFolders[0].uri,
      `Supercharge Your Productivity`,
    );

    commands.executeCommand("vscode.openWith", uri, McpPanel.viewType);
  }

  private createServer(app: express.Application) {
    // Configure HTTPS with certificates
    const mcpSslCertKeyPath = workspace
      .getConfiguration("dbt")
      .get<string>("mcpSslCertKeyPath");
    const mcpSslCertPath = workspace
      .getConfiguration("dbt")
      .get<string>("mcpSslCertPath");

    if (mcpSslCertKeyPath || mcpSslCertPath) {
      // Create HTTPS server with certificates
      let certBuffer, keyBuffer;
      try {
        keyBuffer = mcpSslCertKeyPath
          ? fs.readFileSync(mcpSslCertKeyPath)
          : undefined;
        certBuffer = mcpSslCertPath
          ? fs.readFileSync(mcpSslCertPath)
          : undefined;
      } catch (readErr) {
        this.dbtTerminal.error(
          "DbtPowerUserMcpServer",
          "Failed to read SSL certificates",
          readErr,
        );
        throw readErr;
      }
      const httpsOptions = {
        key: keyBuffer,
        cert: certBuffer,
      };
      this.dbtTerminal.debug(
        "DbtPowerUserMcpServer",
        "Starting HTTPS server",
        mcpSslCertKeyPath,
        mcpSslCertPath,
      );
      return { https: true, server: https.createServer(httpsOptions, app) };
    } else {
      // Create HTTP server if no certificates are provided
      this.dbtTerminal.debug(
        "DbtPowerUserMcpServer",
        "Starting HTTP server (no SSL certificates provided)",
      );
      return { https: false, server: http.createServer(app) };
    }
  }

  public async start() {
    if (!this.altimate.handlePreviewFeatures()) {
      this.dbtTerminal.info(
        "DbtPowerUserMcpServer",
        "Preview features are not enabled, skipping MCP server start",
      );
      return;
    }

    if (this.mcpServer) {
      this.dbtTerminal.info(
        "DbtPowerUserMcpServer",
        "MCP server is already running, skipping start",
      );
      return this.port;
    }

    this.dbtTerminal.info("DbtPowerUserMcpServer", "Starting MCP server");
    const { server, cleanup } = this.dbtPowerUserMcpServerTools.createServer();
    this.mcpServer = server;
    const app = express();

    // Add error handling middleware
    app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        this.dbtTerminal.error("DbtPowerUserMcpServer", "Express error", {
          error: err.message,
          stack: err.stack,
          path: req.path,
          method: req.method,
        });
        res.status(500).json({
          error: "Internal Server Error",
          message: err.message,
        });
      },
    );

    // Add async error handling wrapper
    type ExpressHandler = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => Promise<void>;
    const asyncHandler =
      (fn: ExpressHandler) =>
      (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        Promise.resolve(fn(req, res, next)).catch(next);
      };

    app.get(
      "/sse",
      asyncHandler(async (req: express.Request, res: express.Response) => {
        // Disable request and response timeouts
        req.socket.setTimeout(0);

        this.dbtTerminal.info("DbtPowerUserMcpServer", "Received connection");
        this.mcpTransport = new SSEServerTransport("/message", res);
        await this.mcpServer?.connect(this.mcpTransport);

        // Send an initial ping to establish the connection
        res.write(": ping\n\n");

        // Set up periodic pings every 15 seconds to keep connection alive
        const pingInterval = setInterval(() => {
          res.write(": ping\n\n");
        }, PING_INTERVAL);

        if (this.mcpServer) {
          this.mcpServer.onclose = async () => {
            clearInterval(pingInterval);
            await cleanup();
          };
          this.mcpServer.oninitialized = async () => {
            this.dbtTerminal.info(
              "DbtPowerUserMcpServer",
              "MCP server initialized",
            );
          };
        }

        this.mcpTransport.onerror = (error) => {
          clearInterval(pingInterval);
          this.dbtTerminal.error("DbtPowerUserMcpServer", "Error", {
            error: error.message,
          });
        };

        // Handle client disconnect
        req.on("close", () => {
          clearInterval(pingInterval);
        });
      }),
    );

    app.post(
      "/message",
      asyncHandler(async (req: express.Request, res: express.Response) => {
        this.dbtTerminal.debug("DbtPowerUserMcpServer", "Received message", {
          params: req.params,
        });

        try {
          await this.mcpTransport?.handlePostMessage(req, res);
        } catch (error) {
          this.dbtTerminal.error("DbtPowerUserMcpServer", "Error", error);
        }
      }),
    );

    const port = await findAvailablePort();

    const { https: isHttps, server: httpServer } = this.createServer(app);

    this.isHttps = isHttps;
    httpServer.listen(port, () => {
      this.port = port;
      this.dbtTerminal.info(
        "DbtPowerUserMcpServer",
        "Server is running",
        false,
        {
          port,
          isHttps,
        },
      );
      if (!isCursor()) {
        // This should only be called in vscode
        this.dbtChatParticipant.initializeChatParticipant(
          this.getMcpServerUrl(),
        );
      }
    });

    return port;
  }

  dispose() {
    this.mcpServer?.close();
    this.mcpTransport?.close();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  public getMcpServerUrl(): string | undefined {
    if (!this.port) {
      return undefined;
    }
    return this.isHttps
      ? `https://localhost:${this.port}/sse`
      : `http://localhost:${this.port}/sse`;
  }

  public async updatePortInCursorMcpSettings(port: number) {
    try {
      this.dbtTerminal.debug(
        "DbtPowerUserMcpServer",
        "Updating port in Cursor MCP settings",
        { port },
      );
      const excludePattern = "**/{dbt_packages,site-packages}";
      const mcpJsonPaths = await workspace.findFiles(
        "**/.cursor/mcp.json",
        excludePattern,
        1,
      );

      // if no mcp.json file is found, create one in first workspace folder
      if (!mcpJsonPaths.length) {
        this.dbtTerminal.debug(
          "DbtPowerUserMcpServer",
          "No MCP settings file found",
        );
        if (!workspace.workspaceFolders) {
          window.showErrorMessage(
            "No workspace folders found, please open a workspace to use MCP server",
          );
          this.dbtTerminal.info(
            "DbtPowerUserMcpServer",
            "No workspace folders found",
          );
          return false;
        }

        await workspace.fs.writeFile(
          Uri.file(
            path.join(
              workspace.workspaceFolders[0].uri.fsPath,
              ".cursor",
              "mcp.json",
            ),
          ),
          new Uint8Array(
            Buffer.from(
              JSON.stringify(
                {
                  mcpServers: {
                    dbtPowerUser: { url: this.getMcpServerUrl() },
                  },
                },
                null,
                2,
              ),
            ),
          ),
        );
        return true;
      }

      // if there is more than one mcp.json file, use the first one and update port
      const mcpJsonPath = mcpJsonPaths[0];
      // Try to read the existing file
      const fileContent = await workspace.fs.readFile(mcpJsonPath);
      const config = JSON.parse(fileContent.toString());

      // Update the port in the config
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      config.mcpServers.dbtPowerUser = {
        url: this.getMcpServerUrl(),
      };

      // Write the updated config back to the file
      await workspace.fs.writeFile(
        mcpJsonPath,
        new Uint8Array(Buffer.from(JSON.stringify(config, null, 2))),
      );

      this.dbtTerminal.info(
        "DbtPowerUserMcpServer",
        "Updated Cursor MCP settings",
        false,
        { port },
      );
      return true;
    } catch (err) {
      this.dbtTerminal.error(
        "DbtPowerUserMcpServer",
        "Failed to update MCP settings",
        { error: err },
      );
      return false;
    }
  }
}
