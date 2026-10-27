/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { layoutCommand, findCommand, waitCommand } from './ui-layout.js';
import { windowCommand } from './ui-window.js';
import { screenshotCommand } from './ui-screenshot.js';
import { screenrecordCommand } from './ui-screenrecord.js';
import {
  clickCommand,
  doubleclickCommand,
  longclickCommand,
  swipeCommand,
  flingCommand,
  dragCommand,
  dircflingCommand,
  textCommand,
} from './ui-input.js';

const uiCommand = new Command('ui').description(
  'Inspect and interact with UI on a connected device'
);

uiCommand.addCommand(layoutCommand);
uiCommand.addCommand(findCommand);
uiCommand.addCommand(waitCommand);
uiCommand.addCommand(windowCommand);
uiCommand.addCommand(screenshotCommand);
uiCommand.addCommand(screenrecordCommand);
uiCommand.addCommand(clickCommand);
uiCommand.addCommand(doubleclickCommand);
uiCommand.addCommand(longclickCommand);
uiCommand.addCommand(swipeCommand);
uiCommand.addCommand(flingCommand);
uiCommand.addCommand(dragCommand);
uiCommand.addCommand(dircflingCommand);
uiCommand.addCommand(textCommand);

export default uiCommand;
