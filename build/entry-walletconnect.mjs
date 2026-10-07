// WalletConnect for the front page (dapp/vendor/tacit-walletconnect.min.js): the Ethereum provider, without a modal of
// its own, and a QR encoder for the page's sheet. Built by build-walletconnect.mjs; loaded only when it is chosen.
export { EthereumProvider } from '@walletconnect/ethereum-provider';
export { default as qrcode } from 'qrcode-generator';
