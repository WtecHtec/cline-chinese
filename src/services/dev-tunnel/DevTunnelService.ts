import * as http from "http"
import * as vscode from "vscode"
import getPort, { portNumbers } from "get-port"
import { Controller } from "../../core/controller"
import { WebviewProvider } from "../../core/webview/WebviewProvider"
import { v4 as uuidv4 } from "uuid"

export class DevTunnelService {
	private static instance: DevTunnelService
	private server: http.Server | null = null
	private port: number = 0
	private controller: Controller | null = null
	private pendingRequests: Map<string, http.ServerResponse> = new Map()

	private constructor() {}

	public static getInstance(): DevTunnelService {
		if (!DevTunnelService.instance) {
			DevTunnelService.instance = new DevTunnelService()
		}
		return DevTunnelService.instance
	}

	public setController(controller: Controller) {
		this.controller = controller
	}

	public async start(preferredPort: number = 3000): Promise<void> {
		if (this.server) {
			if (this.port === preferredPort) {
				return // Already running on the same port
			}
			await this.stop()
		}

		try {
			this.port = await getPort({ port: portNumbers(preferredPort, preferredPort + 100) })
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to find an available port starting from ${preferredPort}`)
			throw error
		}

		this.server = http.createServer((req, res) => {
			// Enable CORS
			res.setHeader("Access-Control-Allow-Origin", "*")
			res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
			res.setHeader("Access-Control-Allow-Headers", "Content-Type")

			if (req.method === "OPTIONS") {
				res.writeHead(200)
				res.end()
				return
			}

			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk.toString()
				})
				req.on("end", () => {
					console.log("Received POST request:", body)
					const provider = WebviewProvider.getVisibleInstance()
					if (provider) {
						const requestId = uuidv4()
						this.pendingRequests.set(requestId, res)
						provider.postMessageToWebview({
							type: "dev_tunnel_data",
							dev_tunnel_data: {
								data: body,
								request_id: requestId,
							},
						})
						// Set a timeout to clean up pending requests if no response is received
						setTimeout(() => {
							if (this.pendingRequests.has(requestId)) {
								const pendingRes = this.pendingRequests.get(requestId)
								if (pendingRes) {
									pendingRes.writeHead(504, { "Content-Type": "application/json" })
									pendingRes.end(JSON.stringify({ message: "Timeout waiting for frontend response" }))
								}
								this.pendingRequests.delete(requestId)
							}
						}, 30000) // 30 seconds timeout
					} else {
						res.writeHead(503, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ message: "No visible webview to handle request" }))
					}
				})
			} else {
				res.writeHead(200, { "Content-Type": "text/plain" })
				res.end("DevTunnel is running!")
			}
		})

		return new Promise((resolve, reject) => {
			this.server!.listen(this.port, () => {
				vscode.window.showInformationMessage(`DevTunnel started at http://localhost:${this.port}`)
				this.updateGlobalState()
				resolve()
			})

			this.server!.on("error", (err: any) => {
				vscode.window.showErrorMessage(`Failed to start DevTunnel: ${err.message}`)
				this.server = null
				reject(err)
			})
		})
	}

	public async stop(): Promise<void> {
		if (this.server) {
			return new Promise((resolve, reject) => {
				this.server!.close((err) => {
					if (err) {
						reject(err)
					} else {
						this.server = null
						this.port = 0
						this.updateGlobalState(false)
						vscode.window.showInformationMessage("DevTunnel stopped")
						// Clean up any pending requests
						this.pendingRequests.forEach((res) => {
							res.writeHead(503, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ message: "DevTunnel stopped" }))
						})
						this.pendingRequests.clear()
						resolve()
					}
				})
			})
		}
	}

	public handleDevTunnelResponse(requestId: string, success: boolean) {
		const res = this.pendingRequests.get(requestId)
		if (res) {
			if (success) {
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ message: "Received and processed by frontend" }))
			} else {
				res.writeHead(500, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ message: "Frontend failed to process request" }))
			}
			this.pendingRequests.delete(requestId)
		}
	}

	public isRunning(): boolean {
		return this.server !== null
	}

	public getPort(): number {
		return this.port
	}

	private async updateGlobalState(useDevTunnel: boolean = true) {
		if (this.controller) {
			const currentSettings = (await this.controller.getStateToPostToWebview()).autoApprovalSettings
			const newSettings = {
				...currentSettings,
				version: (currentSettings.version || 1) + 1,
				devTunnelPort: this.port > 0 ? this.port : undefined,
				useDevTunnel: useDevTunnel && this.port > 0,
			}
			this.controller.cacheService.setGlobalState("autoApprovalSettings", newSettings)
			await this.controller.postStateToWebview()
		}
	}
}
