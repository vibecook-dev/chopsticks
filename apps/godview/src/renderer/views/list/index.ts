import type { AgentMonitorView } from '../../monitor/types.js';
import { AgentList } from './AgentList.js';
import { LIST_PARAMETER_GROUPS } from './list-parameters.js';

export const listMonitorView: AgentMonitorView = {
  id: 'list',
  label: 'LIST',
  parameterGroups: LIST_PARAMETER_GROUPS,
  Component: AgentList,
};
