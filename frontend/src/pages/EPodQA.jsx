import React from 'react';
import EPodAgentPage from './EPodAgentPage';

export default function EPodQA() {
  return <EPodAgentPage proxyBase="/epod-qa" title="QA Server" adminPermission="stopScriptQA" />;
}