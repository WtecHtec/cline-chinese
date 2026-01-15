import * as assert from "assert"
import * as http from "http"
import * as sinon from "sinon"
import * as vscode from "vscode"
const proxyquire = require("proxyquire")

describe("DevTunnelService", () => {
	let DevTunnelService: any
	let service: any
	let showInformationMessageStub: sinon.SinonStub
	let showErrorMessageStub: sinon.SinonStub
	let webviewProviderMock: any
	let vscodeMock: any

	beforeEach(async () => {
		// Reset stubs
		sinon.restore()

		vscodeMock = {
			window: {
				showInformationMessage: sinon.stub(),
				showErrorMessage: sinon.stub(),
			},
		}

		showInformationMessageStub = vscodeMock.window.showInformationMessage
		showErrorMessageStub = vscodeMock.window.showErrorMessage

		webviewProviderMock = {
			getVisibleInstance: sinon.stub(),
		}

		// Use proxyquire to load DevTunnelService with mocked dependencies
		const module = proxyquire("../DevTunnelService", {
			vscode: vscodeMock,
			"../../core/controller": { Controller: class {} },
			"../../core/webview/WebviewProvider": { WebviewProvider: webviewProviderMock },
		})
		DevTunnelService = module.DevTunnelService

		service = DevTunnelService.getInstance()
		// Reset service state if needed
		if (service.isRunning()) {
			await service.stop()
		}
	})

	afterEach(async () => {
		if (service && service.isRunning()) {
			await service.stop()
		}
		sinon.restore()
	})

	it("should start the server", async () => {
		await service.start()
		assert.strictEqual(service.isRunning(), true)
		assert.ok(service.getPort() >= 3000)
		assert.ok(showInformationMessageStub.calledWith(`DevTunnel started at http://localhost:${service.getPort()}`))
	})

	it("should stop the server", async () => {
		await service.start()
		await service.stop()
		assert.strictEqual(service.isRunning(), false)
		assert.ok(showInformationMessageStub.calledWith("DevTunnel stopped"))
	})

	it("should handle POST request", async () => {
		await service.start()
		const port = service.getPort()

		const postMessageStub = sinon.stub()
		webviewProviderMock.getVisibleInstance.returns({
			postMessageToWebview: postMessageStub,
		})

		const postData = JSON.stringify({ test: "data" })
		const options = {
			hostname: "localhost",
			port: port,
			path: "/",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(postData),
			},
		}

		await new Promise<void>((resolve, reject) => {
			const req = http.request(options, (res) => {
				assert.strictEqual(res.statusCode, 200)
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => {
					const response = JSON.parse(data)
					assert.strictEqual(response.message, "Received")
					resolve()
				})
			})
			req.on("error", reject)
			req.write(postData)
			req.end()
		})

		assert.ok(postMessageStub.calledOnce)
		assert.deepStrictEqual(postMessageStub.firstCall.args[0], {
			type: "dev_tunnel_data",
			dev_tunnel_data: postData,
		})
	})

	it("should find available port", async () => {
		// Start a dummy server on port 3000
		const dummyServer = http.createServer()
		await new Promise<void>((resolve) => dummyServer.listen(3000, resolve))

		try {
			await service.start(3000)
			assert.notStrictEqual(service.getPort(), 3000)
			assert.ok(service.getPort() > 3000)
		} finally {
			dummyServer.close()
		}
	})
})
