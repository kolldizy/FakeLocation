/**
 * One-way requests from a view to the application shell.
 *
 * View modules never call each other, and none of them owns navigation, the emergency
 * stop or the limitations dialog — app.js does. Rather than import app.js back into a
 * view (a cycle) the view dispatches one of these events and the shell answers it, so
 * the single implementation of "stop and restore GPS" stays in one place.
 */

export const NAVIGATE = "location-studio:navigate";
export const EMERGENCY_STOP = "location-studio:emergency-stop";
export const LIMITATIONS = "location-studio:limitations";

function send(name, detail) {
  document.dispatchEvent(new CustomEvent(name, detail ? { detail } : undefined));
}

export const navigate = (view) => send(NAVIGATE, { view });
export const requestEmergencyStop = () => send(EMERGENCY_STOP);
export const requestLimitations = () => send(LIMITATIONS);
