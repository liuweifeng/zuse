import {
	ApiPaths,
	CloudWorkspaceOpError,
	type MachineErrorCode,
	OrganizationError,
} from "@zuse/contracts";

export const organizationControlError = (
	code: MachineErrorCode,
): OrganizationError =>
	new OrganizationError({
		code:
			code === "access-denied"
				? "not-allowed"
				: code === "not-allowed" ||
						code === "organization-limit-reached" ||
						code === "organization-member-limit-reached" ||
						code === "not-found" ||
						code === "conflict" ||
						code === "invalid-request"
					? code
					: "unavailable",
	});

export const controlApiErrorCode = (
	status: number,
	code: unknown,
	path?: string,
): MachineErrorCode => {
	if (path === ApiPaths.organizations && status === 404)
		return "provider-unavailable";
	if (code === "organization_limit_reached")
		return "organization-limit-reached";
	if (code === "organization_member_limit_reached")
		return "organization-member-limit-reached";
	if (code === "machine_alpha_not_allowed") {
		return "not-allowed";
	}
	if (code === "cloud_beta_access_required") {
		return "beta-access-required";
	}
	if (code === "cloud_beta_access_unavailable") {
		return "beta-access-unavailable";
	}
	if (code === "invalid_machine_offer") {
		return "invalid-offer";
	}
	if (code === "entitlement_required") {
		return "entitlement-required";
	}
	if (code === "cloud_billing_hold" || code === "billing_hold")
		return "billing-hold";
	if (code === "cloud_entitlement_required") return "entitlement-required";
	if (
		code === "cloud_project_not_ready" ||
		code === "cloud_image_rebuild_required"
	)
		return "invalid-state";
	if (code === "cloud_workspace_unavailable") return "invalid-state";
	if (code === "workspace_runtime_update_required") return "invalid-request";
	if (code === "cloud_credential_connection_required")
		return "credential-required";
	if (
		typeof code === "string" &&
		(code === "cloud_branch_in_use" || code.startsWith("cloud_branch_in_use:"))
	)
		return "branch-in-use";
	if (code === "machine_limit_reached") {
		return "machine-limit-reached";
	}
	if (code === "tunnel_unavailable") {
		return "tunnel-unavailable";
	}
	if (code === "billing_approval_pending") {
		return "billing-unavailable";
	}
	if (code === "machine_not_found" || status === 404) {
		return "not-found";
	}
	if (code === "invalid_machine_state" || code === "machine_not_recoverable") {
		return "invalid-state";
	}

	if (status === 403) return "access-denied";
	if (status === 401) {
		return "not-allowed";
	}
	if (status === 409) return "conflict";
	if (status >= 500 || status === 429) return "provider-unavailable";
	return "invalid-request";
};

export const cloudControlError = (
	code: MachineErrorCode,
): CloudWorkspaceOpError =>
	new CloudWorkspaceOpError({
		code:
			code === "billing-unavailable"
				? "billing-hold"
				: code === "invalid-state"
					? "project-not-ready"
					: code === "machine-limit-reached" ||
							code === "organization-limit-reached" ||
							code === "organization-member-limit-reached" ||
							code === "invalid-offer" ||
							code === "enrollment-expired" ||
							code === "enrollment-rejected" ||
							code === "tunnel-unavailable"
						? "invalid-request"
						: code,
	});
