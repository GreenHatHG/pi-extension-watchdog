// Safety net for running this suite inside a pi sub-agent: the launching pane sets the REAL
// PI_WATCHDOG_ON_STOP (a shell chain that writes the run's exit file and kill-sessions the pane).
// Inherited by every vitest worker, any test calling watchdog_decide("done") would fire it for
// real and kill the sub-agent mid-run. Tests own their hook env: delete it up front (on-stop
// tests set their own override afterwards).
delete process.env.PI_WATCHDOG_ON_STOP;
delete process.env.PI_WATCHDOG;
delete process.env.PI_SUBAGENT_DEBUG;
