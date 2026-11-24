import React from 'react';
import EPodAgentPage from './EPodAgentPage';

export default function EPodProd() {
  return <EPodAgentPage proxyBase="/epod-prod" title="PROD Server" adminPermission="stopScriptProd" />;
}