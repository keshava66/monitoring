import React from 'react';
import EPodAgentPage from './EPodAgentPage';

export default function EPodDev() {
  return <EPodAgentPage proxyBase="/epod-dev" title="DEV Server" adminPermission="stopScriptDev" />;
}