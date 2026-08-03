import type { AgentMonitorView } from '../../monitor/types.js';
import { AgentSwarm } from './AgentSwarm.js';
import { SWARM_PARAMETER_GROUPS } from './swarm-parameters.js';

export const swarmMonitorView: AgentMonitorView = {
  id: 'swarm',
  label: 'SWARM',
  parameterGroups: SWARM_PARAMETER_GROUPS,
  Component: AgentSwarm,
};
