/**
 * @format
 */

// Polyfill crypto.getRandomValues for uuid + AES key/IV generation (Hermes has
// no WebCrypto). MUST be imported before anything that uses crypto.
import 'react-native-get-random-values';
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
