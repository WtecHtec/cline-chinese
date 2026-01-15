import { Controller } from ".."
import { AutoApprovalSettingsRequest } from "@shared/proto/cline/state"
import { Empty } from "@shared/proto/cline/common"
import { convertProtoToAutoApprovalSettings } from "../../../shared/proto-conversions/models/auto-approval-settings-conversion"
import { DevTunnelService } from "../../../services/dev-tunnel/DevTunnelService"

/**
 * Updates the auto approval settings
 * @param controller The controller instance
 * @param request The auto approval settings request
 * @returns Empty response
 */
export async function updateAutoApprovalSettings(controller: Controller, request: AutoApprovalSettingsRequest): Promise<Empty> {
	const currentSettings = (await controller.getStateToPostToWebview()).autoApprovalSettings
	const incomingVersion = request.version
	const currentVersion = currentSettings?.version ?? 1

	// Only update if incoming version is higher
	if (incomingVersion > currentVersion) {
		const settings = convertProtoToAutoApprovalSettings(request)

		controller.cacheService.setGlobalState("autoApprovalSettings", settings)

		if (controller.task) {
			controller.task.updateAutoApprovalSettings(settings)
		}

		// Handle DevTunnel service
		const devTunnelService = DevTunnelService.getInstance()
		devTunnelService.setController(controller)
		if (settings.actions.useDevTunnel) {
			if (!devTunnelService.isRunning()) {
				try {
					await devTunnelService.start()
				} catch (error) {
					// Revert setting if start failed
					settings.actions.useDevTunnel = false
					controller.cacheService.setGlobalState("autoApprovalSettings", settings)
					// We might want to notify frontend to revert UI, but for now state update will handle it on next poll/push
				}
			}
		} else {
			if (devTunnelService.isRunning()) {
				await devTunnelService.stop()
			}
		}

		await controller.postStateToWebview()
	}

	return Empty.create()
}
