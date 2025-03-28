import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DBTProjectContainer } from "../manifest/dbtProjectContainer";
import { Uri, Disposable, workspace } from "vscode";
import { provideSingleton } from "../utils";
import {
  DBTProject,
  DBTTerminal,
  TelemetryEvents,
  TelemetryService,
} from "@extension";
import { RunModelParams } from "../dbt_client/dbtIntegration";
import { CommandProcessResult } from "../commandProcessExecution";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const BaseSchema = z.object({});
const BaseProjectRootSchema = BaseSchema.extend({ projectRoot: z.string() });
const GetColumnsOfModelSchema = BaseProjectRootSchema.extend({
  modelName: z.string(),
});
const GetColumnsOfSourceSchema = BaseProjectRootSchema.extend({
  sourceName: z.string(),
  tableName: z.string(),
});
const GetColumnValuesSchema = BaseProjectRootSchema.extend({
  model: z.string(),
  column: z.string(),
});
const CompileModelSchema = BaseProjectRootSchema.extend({
  modelName: z.string(),
});
const CompileQuerySchema = BaseProjectRootSchema.extend({
  query: z.string(),
  originalModelName: z.string().optional(),
});
const ExecuteSQLSchema = BaseProjectRootSchema.extend({
  query: z.string(),
  modelName: z.string(),
});
const RunModelSchema = BaseProjectRootSchema.extend({
  plusOperatorLeft: z.enum(["", "+"]),
  modelName: z.string(),
  plusOperatorRight: z.enum(["", "+"]),
});
const BuildModelSchema = BaseProjectRootSchema.extend({
  plusOperatorLeft: z.enum(["", "+"]),
  modelName: z.string(),
  plusOperatorRight: z.enum(["", "+"]),
});
const BuildProjectSchema = BaseProjectRootSchema.extend({});
const RunTestSchema = BaseProjectRootSchema.extend({
  testName: z.string(),
});
const RunModelTestSchema = BaseProjectRootSchema.extend({
  modelName: z.string(),
});
const AddDbtPackagesSchema = BaseProjectRootSchema.extend({
  packages: z.array(z.string()),
});
const InstallDepsSchema = BaseProjectRootSchema.extend({});

const GetChildrenModelsSchema = BaseProjectRootSchema.extend({
  table: z.string(),
});

const GetParentModelsSchema = BaseProjectRootSchema.extend({
  table: z.string(),
});

enum ToolName {
  GET_PROJECTS = "get_projects",
  GET_CHILDREN_MODELS = "get_children_models",
  GET_PARENT_MODELS = "get_parent_models",
  GET_COLUMNS_OF_MODEL = "get_columns_of_model",
  GET_COLUMNS_OF_SOURCE = "get_columns_of_source",
  GET_COLUMN_VALUES = "get_column_values",
  COMPILE_MODEL = "compile_model",
  COMPILE_QUERY = "compile_query",
  EXECUTE_SQL = "execute_sql",
  RUN_MODEL = "run_model",
  BUILD_MODEL = "build_model",
  BUILD_PROJECT = "build_project",
  RUN_TEST = "run_test",
  RUN_MODEL_TEST = "run_model_test",
  ADD_DBT_PACKAGES = "add_dbt_packages",
  INSTALL_DEPS = "install_deps",
}

@provideSingleton(DbtPowerUserMcpServerTools)
export class DbtPowerUserMcpServerTools implements Disposable {
  constructor(
    private dbtProjectContainer: DBTProjectContainer,
    private dbtTerminal: DBTTerminal,
    private telemetry: TelemetryService,
  ) {}

  dispose() {}

  private handleDbtCommandOutput = (result?: CommandProcessResult) => {
    if (result?.stderr) {
      throw new Error(result.stderr);
    }
    return {
      content: [
        {
          type: "text",
          text: result?.stdout,
        },
      ],
    };
  };

  public createServer = () => {
    const server = new Server(
      {
        name: "DbtPowerUserMcpServerTools",
        version: "1.0.0",
      },
      {
        capabilities: {
          prompts: {},
          resources: { subscribe: true },
          tools: {},
          logging: {},
        },
      },
    );

    server.onerror = (error) => {
      this.dbtTerminal.error("DbtPowerUserMcpServerTools", "Error", { error });
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.dbtTerminal.debug("DbtPowerUserMcpServerTools", "Listing tools");
      const tools: Tool[] = [
        {
          name: ToolName.GET_PROJECTS,
          description: `Returns detailed information about all available dbt projects including:
  - projectRoot: The root directory path of the dbt project
  - projectName: The name of the dbt project from dbt_project.yml
  - selectedTarget: The currently selected target profile
  - targetNames: List of all available target profiles
  - targetPath: The directory where compiled artifacts are stored
  - packageInstallPath: The directory where dbt packages are installed
  - modelPaths: List of directories containing dbt models
  - seedPaths: List of directories containing dbt seeds
  - macroPaths: List of directories containing dbt macros
  - manifestPath: Path to the manifest.json file
  - catalogPath: Path to the catalog.json file
  - dbtVersion: The version of dbt being used (e.g., "1.5.0")
  - adapterType: The database adapter type (e.g., "postgres", "snowflake")
  This must be called first to get the projectRoot parameter needed for all other tools.`,
          inputSchema: zodToJsonSchema(BaseSchema) as ToolInput,
        },
        {
          name: ToolName.GET_COLUMNS_OF_MODEL,
          description:
            "Returns the column names and data types for a specified dbt model. Use this to understand a model's schema before querying it.",
          inputSchema: zodToJsonSchema(GetColumnsOfModelSchema) as ToolInput,
        },
        {
          name: ToolName.GET_COLUMNS_OF_SOURCE,
          description:
            "Returns the column names and data types for a specified dbt source. Use this to understand a source's schema before querying it.",
          inputSchema: zodToJsonSchema(GetColumnsOfSourceSchema) as ToolInput,
        },
        ...(workspace
          .getConfiguration("dbt")
          .get<boolean>("enableMcpDataSourceQueryTools", false)
          ? [
              {
                name: ToolName.GET_COLUMN_VALUES,
                description:
                  "Returns the distinct values for a specified column in a model or source. Use this to understand the data distribution and possible values in a column.",
                inputSchema: zodToJsonSchema(
                  GetColumnValuesSchema,
                ) as ToolInput,
              },
              {
                name: ToolName.EXECUTE_SQL,
                description:
                  "Executes SQL queries against the database, returning processed results immediately. Use this to test queries and retrieve data from the database.",
                inputSchema: zodToJsonSchema(ExecuteSQLSchema) as ToolInput,
              },
            ]
          : []),
        {
          name: ToolName.COMPILE_MODEL,
          description:
            "Converts a dbt model's Jinja SQL into raw SQL. Use this to inspect the generated SQL before executing it. Note: This does not validate if the SQL will run successfully.",
          inputSchema: zodToJsonSchema(CompileModelSchema) as ToolInput,
        },
        {
          name: ToolName.COMPILE_QUERY,
          description:
            "Compile query, this will only convert the Jinja SQL to SQL, not determine if the SQL actually works. If the compilation succeeds, use the execute SQL and validate the data.",
          inputSchema: zodToJsonSchema(CompileQuerySchema) as ToolInput,
        },
        {
          name: ToolName.RUN_MODEL,
          description:
            "Executes a dbt model in the database. Use + for plusOperatorLeft to include parent models, and + for plusOperatorRight to include child models in the run.",
          inputSchema: zodToJsonSchema(RunModelSchema) as ToolInput,
        },
        {
          name: ToolName.BUILD_MODEL,
          description:
            "Builds a dbt model in the database. Use + for plusOperatorLeft to include parent models, and + for plusOperatorRight to include child models in the build.",
          inputSchema: zodToJsonSchema(BuildModelSchema) as ToolInput,
        },
        {
          name: ToolName.BUILD_PROJECT,
          description:
            "Builds the dbt project, this will run seeds, models and all related tests",
          inputSchema: zodToJsonSchema(BuildProjectSchema) as ToolInput,
        },
        {
          name: ToolName.RUN_TEST,
          description:
            "Run an indivdual test based on the test name in the dbt manifest.",
          inputSchema: zodToJsonSchema(RunTestSchema) as ToolInput,
        },
        {
          name: ToolName.RUN_MODEL_TEST,
          description:
            "Run model tests, use this tool to run the existing tests defined for the dbt model",
          inputSchema: zodToJsonSchema(RunModelTestSchema) as ToolInput,
        },
        {
          name: ToolName.ADD_DBT_PACKAGES,
          description:
            "Add dbt package(s) to the project, the dbt package string should be in the form of packageName@version",
          inputSchema: zodToJsonSchema(AddDbtPackagesSchema) as ToolInput,
        },
        {
          name: ToolName.INSTALL_DEPS,
          description:
            "Install dbt package dependencies based on the dbt projects's packages.yml file",
          inputSchema: zodToJsonSchema(InstallDepsSchema) as ToolInput,
        },
        {
          name: ToolName.GET_CHILDREN_MODELS,
          description:
            "Returns the list of models that depend on the specified model (its children). Use this to understand a model's downstream impact and lineage.",
          inputSchema: zodToJsonSchema(GetChildrenModelsSchema) as ToolInput,
        },
        {
          name: ToolName.GET_PARENT_MODELS,
          description:
            "Returns the list of models that the specified model depends on (its parents). Use this to understand a model's upstream dependencies and lineage.",
          inputSchema: zodToJsonSchema(GetParentModelsSchema) as ToolInput,
        },
      ];

      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      this.dbtTerminal.debug("DbtPowerUserMcpServerTools", "Calling tool", {
        name,
        args,
      });
      this.telemetry.sendTelemetryEvent(TelemetryEvents["MCP/ToolCall"], {
        name,
        ...args,
      });

      try {
        if (name === ToolName.GET_PROJECTS) {
          const projects = this.dbtProjectContainer.getProjects();

          const projectDetails = await Promise.all(
            projects.map(async (project: DBTProject) => {
              const details: Record<string, any> = {
                projectRoot: project.projectRoot.fsPath,
              };

              await this.safeGetProjectProperty(
                project,
                "projectName",
                () => project.getProjectName(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "selectedTarget",
                () => project.getSelectedTarget(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "targetNames",
                () => project.getTargetNames(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "targetPath",
                () => project.getTargetPath(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "packageInstallPath",
                () => project.getPackageInstallPath(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "modelPaths",
                () => project.getModelPaths(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "seedPaths",
                () => project.getSeedPaths(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "macroPaths",
                () => project.getMacroPaths(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "manifestPath",
                () => project.getManifestPath(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "catalogPath",
                () => project.getCatalogPath(),
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "dbtVersion",
                () => {
                  const version = project.getDBTVersion();
                  return version ? version.join(".") : undefined;
                },
                details,
              );
              await this.safeGetProjectProperty(
                project,
                "adapterType",
                () => project.getAdapterType(),
                details,
              );

              return details;
            }),
          );

          this.dbtTerminal.debug(
            "DbtPowerUserMcpServerTools",
            "Projects loaded",
            projectDetails,
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(projectDetails),
              },
            ],
          };
        }

        const validatedBaseArgs = BaseProjectRootSchema.parse(args);
        const projectRoot = decodeURIComponent(validatedBaseArgs.projectRoot);
        const project = this.dbtProjectContainer.findDBTProject(
          Uri.file(projectRoot),
        );
        if (!project) {
          throw new Error(
            `Project not found for root: ${validatedBaseArgs.projectRoot}`,
          );
        }

        switch (name) {
          case ToolName.GET_COLUMNS_OF_MODEL: {
            const validatedArgs = GetColumnsOfModelSchema.parse(args);
            const result = await project.getColumnsOfModel(
              validatedArgs.modelName,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          }

          case ToolName.GET_COLUMNS_OF_SOURCE: {
            const validatedArgs = GetColumnsOfSourceSchema.parse(args);
            const result = await project.getColumnsOfSource(
              validatedArgs.sourceName,
              validatedArgs.tableName,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          }

          case ToolName.GET_COLUMN_VALUES: {
            const validatedArgs = GetColumnValuesSchema.parse(args);
            return await this.runWithProgress(server, async () => {
              const result = await project.getColumnValues(
                validatedArgs.model,
                validatedArgs.column,
              );
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            });
          }

          case ToolName.COMPILE_MODEL: {
            const validatedArgs = CompileModelSchema.parse(args);
            const result = await project.unsafeCompileNode(
              validatedArgs.modelName,
            );
            return { content: [{ type: "text", text: result || "" }] };
          }

          case ToolName.EXECUTE_SQL: {
            const validatedArgs = ExecuteSQLSchema.parse(args);
            return await this.runWithProgress(server, async () => {
              const result = await project.executeSQL(
                validatedArgs.query,
                validatedArgs.modelName,
                true, // returnImmediately
                false, // returnRawResults
              );
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            });
          }

          case ToolName.RUN_MODEL: {
            const validatedArgs = RunModelSchema.parse(args);
            return await this.runWithProgress(server, async () => {
              const result = await project.unsafeRunModelImmediately({
                plusOperatorLeft: validatedArgs.plusOperatorLeft,
                modelName: validatedArgs.modelName,
                plusOperatorRight: validatedArgs.plusOperatorRight,
              });
              return this.handleDbtCommandOutput(result);
            });
          }

          case ToolName.BUILD_MODEL: {
            const validatedArgs = BuildModelSchema.parse(args);
            return await this.runWithProgress(server, async () => {
              const result = await project.unsafeBuildModelImmediately({
                plusOperatorLeft: validatedArgs.plusOperatorLeft,
                modelName: validatedArgs.modelName,
                plusOperatorRight: validatedArgs.plusOperatorRight,
              });
              return this.handleDbtCommandOutput(result);
            });
          }

          case ToolName.BUILD_PROJECT: {
            return await this.runWithProgress(server, async () => {
              const result = await project.unsafeBuildProjectImmediately();
              return this.handleDbtCommandOutput(result);
            });
          }

          case ToolName.RUN_TEST: {
            const validatedArgs = RunTestSchema.parse(args);
            return await this.runWithProgress(server, async () => {
              const result = await project.unsafeRunTestImmediately(
                validatedArgs.testName,
              );
              return this.handleDbtCommandOutput(result);
            });
          }

          case ToolName.RUN_MODEL_TEST: {
            const validatedArgs = RunModelTestSchema.parse(args);
            return await this.runWithProgress(server, async () => {
              const result = await project.unsafeRunModelTestImmediately(
                validatedArgs.modelName,
              );
              return this.handleDbtCommandOutput(result);
            });
          }

          case ToolName.ADD_DBT_PACKAGES: {
            const validatedArgs = AddDbtPackagesSchema.parse(args);
            const result = await project.installDbtPackages(
              validatedArgs.packages,
            );
            return {
              content: [{ type: "text", text: result }],
            };
          }

          case ToolName.INSTALL_DEPS: {
            const result = await project.installDeps();
            return {
              content: [{ type: "text", text: result }],
            };
          }

          case ToolName.COMPILE_QUERY: {
            const validatedArgs = CompileQuerySchema.parse(args);
            const result = await project.unsafeCompileQuery(
              validatedArgs.query,
              validatedArgs.originalModelName,
            );
            return { content: [{ type: "text", text: result || "" }] };
          }

          case ToolName.GET_CHILDREN_MODELS: {
            const validatedArgs = GetChildrenModelsSchema.parse(args);
            const result = project.getChildrenModels({
              table: validatedArgs.table,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          }

          case ToolName.GET_PARENT_MODELS: {
            const validatedArgs = GetParentModelsSchema.parse(args);
            const result = project.getParentModels({
              table: validatedArgs.table,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        this.dbtTerminal.error("DbtPowerUserMcpServerTools", "Error", {
          error,
        });
        return {
          content: [
            {
              type: "text",
              text: `Unable to complete tool call. ${(error as Error).message}`,
            },
          ],
          isError: true,
          error: error,
        };
      }
    });

    return { server, cleanup: async () => {} };
  };

  private async safeGetProjectProperty<T>(
    project: DBTProject,
    propertyName: string,
    getter: () => T,
    details: Record<string, any>,
  ): Promise<void> {
    try {
      const value = await getter();
      if (value !== undefined && value !== null) {
        details[propertyName] = value;
      }
    } catch (error) {
      this.dbtTerminal.debug(
        "DbtPowerUserMcpServerTools",
        `Failed to get ${propertyName}`,
        error,
      );
    }
  }

  private async runWithProgress<T>(
    server: Server,
    mainOperation: () => Promise<T>,
    progressToken?: string,
    interval: number = 5000,
  ): Promise<T> {
    let operationCompleted = false;

    // Function to send progress updates every `interval` ms
    const sendProgressUpdates = async () => {
      let progress = 0;

      while (!operationCompleted) {
        const sleep = new Promise((resolve) => setTimeout(resolve, interval));
        await Promise.race([
          sleep,
          new Promise((resolve) => {
            if (operationCompleted) {
              resolve(undefined);
            }
          }),
        ]);

        if (operationCompleted) {
          break; // Stop sending updates if operation is done
        }

        progress += interval / 1000; // Convert ms to seconds
        if (progressToken !== undefined) {
          await server.notification({
            method: "notifications/progress",
            params: {
              progress,
              progressToken,
            },
          });
        }
      }
    };

    // Run both tasks in parallel and return the result of mainOperation
    const resultPromise = mainOperation().then((res) => {
      operationCompleted = true; // Mark operation as completed
      return res;
    });

    await Promise.race([resultPromise, sendProgressUpdates()]); // Stop progress updates as soon as mainOperation finishes

    return resultPromise; // Ensure the main operation result is returned
  }
}
