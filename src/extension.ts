// 'vscode' 模块包含 VS Code 扩展性 API
// 导入模块并在下面的代码中使用别名 vscode 引用它

import { DIFF_VIEW_URI_SCHEME } from "@hosts/vscode/VscodeDiffViewProvider"
import { WebviewProviderType as WebviewProviderTypeEnum } from "@shared/proto/cline/ui"
import assert from "node:assert"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import * as vscode from "vscode"
import { sendAccountButtonClickedEvent } from "./core/controller/ui/subscribeToAccountButtonClicked"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendMcpButtonClickedEvent } from "./core/controller/ui/subscribeToMcpButtonClicked"
import { sendSettingsButtonClickedEvent } from "./core/controller/ui/subscribeToSettingsButtonClicked"
import { WebviewProvider } from "./core/webview"
import { createClineAPI } from "./exports"
import { Logger } from "./services/logging/Logger"
import { cleanupTestMode, initializeTestMode } from "./services/test/TestMode"
import { WebviewProviderType } from "./shared/webview/types"
import "./utils/path" // 必要的，以便访问 String.prototype.toPosix

import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import type { ExtensionContext } from "vscode"
import { initialize, tearDown } from "./common"
import { addToCline } from "./core/controller/commands/addToCline"
import { explainWithCline } from "./core/controller/commands/explainWithCline"
import { fixWithCline } from "./core/controller/commands/fixWithCline"
import { improveWithCline } from "./core/controller/commands/improveWithCline"
import { sendAddToInputEvent } from "./core/controller/ui/subscribeToAddToInput"
import { sendFocusChatInputEvent } from "./core/controller/ui/subscribeToFocusChatInput"
import { focusChatInput, getContextForCommand } from "./hosts/vscode/commandUtils"
import { VscodeDiffViewProvider } from "./hosts/vscode/VscodeDiffViewProvider"
import { VscodeWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { GitCommitGenerator } from "./integrations/git/commit-message-generator"
import { AuthService } from "./services/auth/AuthService"
import { telemetryService } from "./services/posthog/PostHogClientProvider"
import { SharedUriHandler } from "./services/uri/SharedUriHandler"
import { ShowMessageType } from "./shared/proto/host/window"
/*
使用 https://github.com/microsoft/vscode-webview-ui-toolkit 构建

灵感来源于
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra

*/

// 当您的扩展被激活时会调用此方法
// 您的扩展在第一次执行命令时被激活
export async function activate(context: vscode.ExtensionContext) {
	setupHostProvider(context)

	const sidebarWebview = (await initialize(context)) as VscodeWebviewProvider

	Logger.log("Cline Chinese 扩展已激活")

	const testModeWatchers = await initializeTestMode(sidebarWebview)
	// 初始化测试模式并将可处理的对象添加到上下文
	context.subscriptions.push(...testModeWatchers)

	vscode.commands.executeCommand("setContext", "clineChinese.isDevMode", IS_DEV && IS_DEV === "true")

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VscodeWebviewProvider.SIDEBAR_ID, sidebarWebview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.plusButtonClicked", async (webview: any) => {
			console.log("[DEBUG] plusButtonClicked", webview)
			// 将 webview 类型传递给事件发送器
			const isSidebar = !webview

			const openChat = async (instance: WebviewProvider) => {
				await instance?.controller.clearTask()
				await instance?.controller.postStateToWebview()
				await sendChatButtonClickedEvent(instance.controller.id)
			}

			if (isSidebar) {
				const sidebarInstance = WebviewProvider.getSidebarInstance()
				if (sidebarInstance) {
					openChat(sidebarInstance)
					// 向侧边栏实例发送事件
				}
			} else {
				const tabInstances = WebviewProvider.getTabInstances()
				for (const instance of tabInstances) {
					openChat(instance)
				}
			}
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.mcpButtonClicked", (webview: any) => {
			console.log("[DEBUG] mcpButtonClicked", webview)

			const activeInstance = WebviewProvider.getActiveInstance()
			const isSidebar = !webview

			if (isSidebar) {
				const sidebarInstance = WebviewProvider.getSidebarInstance()
				const sidebarInstanceId = sidebarInstance?.getClientId()
				if (sidebarInstanceId) {
					sendMcpButtonClickedEvent(sidebarInstanceId)
				} else {
					console.error("[DEBUG] 未找到侧边栏实例，无法发送 MCP 按钮事件")
				}
			} else {
				const activeInstanceId = activeInstance?.getClientId()
				if (activeInstanceId) {
					sendMcpButtonClickedEvent(activeInstanceId)
				} else {
					console.error("[DEBUG] 未找到活动实例，无法发送 MCP 按钮事件")
				}
			}
		}),
	)

	const openClineInNewTab = async () => {
		Logger.log("在新标签页中打开 Cline Chinese")
		// (此示例使用 webviewProvider 激活事件，这对于反序列化缓存的 webview 是必要的，但由于我们使用 retainContextWhenHidden，所以不需要使用该事件)
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
		const tabWebview = HostProvider.get().createWebviewProvider(WebviewProviderType.TAB) as VscodeWebviewProvider
		//const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined
		const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

		// 检查是否有可见的文本编辑器，否则向右打开一个新组
		const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0
		if (!hasVisibleEditors) {
			await vscode.commands.executeCommand("workbench.action.newGroupRight")
		}
		const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

		const panel = vscode.window.createWebviewPanel(VscodeWebviewProvider.TAB_PANEL_ID, "Cline Chinese", targetCol, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri],
		})
		// TODO: 使用更好的带有明暗变体的 svg 图标 (参见 https://stackoverflow.com/questions/58365687/vscode-extension-iconpath)

		panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_light.png"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_dark.png"),
		}
		tabWebview.resolveWebviewView(panel)

		// 锁定编辑器组，以便点击文件不会在面板上打开它们
		await setTimeoutPromise(100)
		await vscode.commands.executeCommand("workbench.action.lockEditorGroup")
		return tabWebview
	}

	context.subscriptions.push(vscode.commands.registerCommand("clineChinese.popoutButtonClicked", openClineInNewTab))
	context.subscriptions.push(vscode.commands.registerCommand("clineChinese.openInNewTab", openClineInNewTab))

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.settingsButtonClicked", (webview: any) => {
			const isSidebar = !webview
			const webviewType = isSidebar ? WebviewProviderTypeEnum.SIDEBAR : WebviewProviderTypeEnum.TAB

			sendSettingsButtonClickedEvent(webviewType)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.historyButtonClicked", async (webview: any) => {
			console.log("[DEBUG] historyButtonClicked", webview)
			// 将 webview 类型传递给事件发送器
			const isSidebar = !webview
			const webviewType = isSidebar ? WebviewProviderTypeEnum.SIDEBAR : WebviewProviderTypeEnum.TAB

			// 使用 gRPC 流式方法向所有订阅者发送事件
			await sendHistoryButtonClickedEvent(webviewType)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.accountButtonClicked", (webview: any) => {
			console.log("[DEBUG] accountButtonClicked", webview)

			const isSidebar = !webview
			if (isSidebar) {
				const sidebarInstance = WebviewProvider.getSidebarInstance()
				if (sidebarInstance) {
					// 向侧边栏控制器发送事件
					sendAccountButtonClickedEvent(sidebarInstance.controller.id)
				}
			} else {
				// 发送到所有标签页实例
				const tabInstances = WebviewProvider.getTabInstances()
				for (const instance of tabInstances) {
					sendAccountButtonClickedEvent(instance.controller.id)
				}
			}
		}),
	)

	/*
	我们使用文本文档内容提供程序 API 通过为原始内容创建虚拟文档来显示差异视图的左侧。
	这使其变为只读，因此用户知道如果要保留更改，应编辑右侧。

	- 此 API 允许您从任意来源在 VSCode 中创建只读文档，通过声明 uri-scheme 来工作，
	您的提供程序然后为该 scheme 返回文本内容。在注册提供程序时必须提供 scheme，
	之后不能更改。
	- 注意提供程序不会为虚拟文档创建 uri - 它的作用是在给定这样的 uri 时提供内容。
	反过来，内容提供程序被连接到打开文档的逻辑中，因此总是会考虑提供程序。
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	const handleUri = async (uri: vscode.Uri) => {
		const success = await SharedUriHandler.handleUri(uri)
		if (!success) {
			console.warn("扩展 URI 处理器: 处理 URI 失败:", uri.toString())
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// 在开发模式下注册大小测试命令
	if (IS_DEV && IS_DEV === "true") {
		// 使用动态导入以避免在生产中加载模块
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(context, sidebarWebview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("Cline Chinese 开发任务命令已注册")
			})
			.catch((error) => {
				Logger.log("注册开发任务命令失败: " + error)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.addTerminalOutputToChat", async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// 保存当前剪贴板内容
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// 复制*现有的*终端选择（不选择全部）
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// 获取复制的内容
				const terminalContents = (await readTextFromClipboard()).trim()

				// 恢复原始剪贴板内容
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// 没有复制终端内容（要么没有选择内容，要么发生了错误）
					return
				}
				// 确保侧边栏视图可见
				await focusChatInput()

				await sendAddToInputEvent(`终端输出:\n\`\`\`\n${terminalContents}\n\`\`\``)

				console.log("addSelectedTerminalOutputToChat", terminalContents, terminal.name)
			} catch (error) {
				// 即使发生错误也要确保剪贴板被恢复
				await writeTextToClipboard(tempCopyBuffer)
				console.error("获取终端内容时出错:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "获取终端内容失败",
				})
			}
		}),
	)

	// 注册代码操作提供程序
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					document: vscode.TextDocument,
					range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					const CONTEXT_LINES_TO_EXPAND = 3
					const START_OF_LINE_CHAR_INDEX = 0
					const LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING = 1

					const actions: vscode.CodeAction[] = []
					const editor = vscode.window.activeTextEditor // 获取活动编辑器以检查选择

					// 扩展范围以包含周围 3 行，或如果选择范围更大则使用选择
					const selection = editor?.selection
					let expandedRange = range
					if (
						editor &&
						selection &&
						!selection.isEmpty &&
						selection.contains(range.start) &&
						selection.contains(range.end)
					) {
						expandedRange = selection
					} else {
						expandedRange = new vscode.Range(
							Math.max(0, range.start.line - CONTEXT_LINES_TO_EXPAND),
							START_OF_LINE_CHAR_INDEX,
							Math.min(
								document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
								range.end.line + CONTEXT_LINES_TO_EXPAND,
							),
							document.lineAt(
								Math.min(
									document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
									range.end.line + CONTEXT_LINES_TO_EXPAND,
								),
							).text.length,
						)
					}

					// 添加到 Cline（总是可用）
					const addAction = new vscode.CodeAction("添加到 Cline", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: "clineChinese.addToChat",
						title: "添加到 Cline Chinese",
						arguments: [expandedRange, context.diagnostics],
					}
					actions.push(addAction)

					// 用 Cline 解释（总是可用）
					const explainAction = new vscode.CodeAction("用 Cline 解释", vscode.CodeActionKind.RefactorExtract) // 使用重构类型
					explainAction.command = {
						command: "clineChinese.explainCode",
						title: "用 Cline Chinese 解释",
						arguments: [expandedRange],
					}
					actions.push(explainAction)

					// 用 Cline 改进（总是可用）
					const improveAction = new vscode.CodeAction("用 Cline 改进", vscode.CodeActionKind.RefactorRewrite) // 使用重构类型
					improveAction.command = {
						command: "clineChinese.improveCode",
						title: "用 Cline Chinese 改进",
						arguments: [expandedRange],
					}
					actions.push(improveAction)

					// 用 Cline 修复（仅在存在诊断时）
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("用 Cline 修复", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: "clineChinese.fixWithCline",
							title: "用 Cline Chinese 修复",
							arguments: [expandedRange, context.diagnostics],
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// 注册命令处理程序
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"clineChinese.addToChat",
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const context = await getContextForCommand(range, diagnostics)
				if (!context) {
					return
				}
				await addToCline(context.controller, context.commandContext)
			},
		),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"clineChinese.fixWithCline",
			async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
				const context = await getContextForCommand(range, diagnostics)
				if (!context) {
					return
				}
				await fixWithCline(context.controller, context.commandContext)
			},
		),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.explainCode", async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await explainWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.improveCode", async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await improveWithCline(context.controller, context.commandContext)
		}),
	)

	// 注册 focusChatInput 命令处理程序
	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.focusChatInput", async () => {
			// 快速路径：检查现有的活动实例
			let activeWebview = WebviewProvider.getLastActiveInstance() as VscodeWebviewProvider

			if (activeWebview) {
				// 实例存在 - 只需显示并聚焦它
				const webview = activeWebview.getWebview()
				if (webview) {
					if (webview && "reveal" in webview) {
						webview.reveal()
					} else if ("show" in webview) {
						webview.show()
					}
				}
			} else {
				// 没有活动实例 - 需要查找或创建一个
				WebviewProvider.setLastActiveControllerId(null)

				// 首先检查现有的标签页实例（比聚焦侧边栏更便宜）
				const tabInstances = WebviewProvider.getTabInstances() as VscodeWebviewProvider[]
				if (tabInstances.length > 0) {
					activeWebview = tabInstances[tabInstances.length - 1]
				} else {
					// 尝试聚焦侧边栏
					await vscode.commands.executeCommand("clineChinese.SidebarProvider.focus")

					// 等待聚焦完成的短暂延迟
					await new Promise((resolve) => setTimeout(resolve, 200))
					activeWebview = WebviewProvider.getSidebarInstance() as VscodeWebviewProvider
					if (!activeWebview) {
						// 最后手段：创建新标签页
						activeWebview = (await openClineInNewTab()) as VscodeWebviewProvider
					}
				}
			}

			// 发送聚焦事件
			const clientId = activeWebview?.getClientId()
			if (!clientId) {
				console.error("FocusChatInput: 无法找到或激活 Cline webview 进行聚焦。")
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "无法激活 Cline Chinese 视图。请尝试从活动栏手动打开它。",
				})
				return
			}

			sendFocusChatInputEvent(clientId)
			telemetryService.captureButtonClick("command_focusChatInput", activeWebview.controller?.task?.ulid)
		}),
	)

	// 注册 openWalkthrough 命令处理程序
	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.openWalkthrough", async () => {
			await vscode.commands.executeCommand(
				"workbench.action.openWalkthrough",
				"HybridTalentComputing.cline-chinese#ClineWalkthrough",
			)
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// 注册 generateGitCommitMessage 命令处理程序
	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.generateGitCommitMessage", async (scm) => {
			await GitCommitGenerator?.generate?.(context, scm)
		}),
		vscode.commands.registerCommand("clineChinese.abortGitCommitMessage", () => {
			GitCommitGenerator?.abort?.()
		}),
	)

	context.subscriptions.push(
		context.secrets.onDidChange(async (event) => {
			if (event.key === "clineAccountId") {
				// 检查密钥是否被移除（注销）或添加/更新（登录）
				const secretValue = await context.secrets.get("clineAccountId")
				const activeWebviewProvider = WebviewProvider.getVisibleInstance()
				const controller = activeWebviewProvider?.controller

				const authService = AuthService.getInstance(controller)
				if (secretValue) {
					// 密钥被添加或更新 - 恢复认证信息（从另一个窗口登录）
					authService?.restoreRefreshTokenAndRetrieveAuthInfo()
				} else {
					// 密钥被移除 - 处理所有窗口的注销
					authService?.handleDeauth()
				}
			}
		}),
	)

	return createClineAPI(sidebarWebview.controller)
}

function setupHostProvider(context: ExtensionContext) {
	console.log("正在设置 vscode 主机提供程序...")

	const createWebview = (type: WebviewProviderType) => new VscodeWebviewProvider(context, type)
	const createDiffView = () => new VscodeDiffViewProvider()
	const outputChannel = vscode.window.createOutputChannel("Cline Chinese")
	context.subscriptions.push(outputChannel)

	const getCallbackUri = async () => `${vscode.env.uriScheme || "vscode"}://HybridTalentComputing.cline-chinese`
	HostProvider.initialize(createWebview, createDiffView, vscodeHostBridgeClient, outputChannel.appendLine, getCallbackUri)
}

import { DevTunnelService } from "./services/dev-tunnel/DevTunnelService"

// 当您的扩展被停用时会调用此方法
export async function deactivate() {
	tearDown()

	// 清理测试模式
	cleanupTestMode()

	// Stop DevTunnel service
	await DevTunnelService.getInstance().stop()

	Logger.log("Cline Chinese 扩展已停用")
}

// TODO: 找到一个解决方案来自动从生产构建中移除 DEV 相关内容。
//  这种类型的代码在生产中保留是可以的。我们只是希望从生产构建中移除它
//  以减少构建资产的大小。
//
// 这是一个变通方法，当源代码更改时重新加载扩展
// 因为 vscode 不支持扩展的热重载
const IS_DEV = process.env.IS_DEV
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

// 设置开发模式文件监视器
if (IS_DEV && IS_DEV !== "false") {
	assert(DEV_WORKSPACE_FOLDER, "在开发中必须设置 DEV_WORKSPACE_FOLDER")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		console.info(`${scheme} ${path} 已更改。正在重新加载 VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}
