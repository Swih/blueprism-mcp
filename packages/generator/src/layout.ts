/**
 * Page layout (G11): the happy path runs down one main column, error branches and recovery
 * sit in a column to its right, data items are grouped in a column further right, and the
 * page info stage sits at the top left. Wait clocks sit left of their condition nodes.
 * Coordinates are stage centres.
 */
export interface Position {
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
}

export const INFO_POSITION: Position = { x: -225, y: -105, w: 210, h: 160 };
export const MAIN_X = 15;
/** Horizontal separation of the Wait clock from its condition in the main flow. */
export const WAIT_CHOICE_DISTANCE = 75;
export const BRANCH_X = 150;
export const DATA_X = 300;
export const TOP_Y = -165;
/** Vertical distance between two stages of the main or branch column. */
export const ROW = 60;
/** Vertical distance between two data items. */
export const DATA_ROW = 45;

/** Hands out positions column by column, top to bottom, never twice the same slot. */
export class PageLayout {
  private mainY = TOP_Y;
  private branchY = TOP_Y;
  private dataY = TOP_Y;

  main(): Position {
    const y = this.mainY;
    this.mainY += ROW;
    return { x: MAIN_X, y };
  }

  /** Same row as the flow, with room on the right for Blue Prism's condition label. */
  wait(): Position {
    return { ...this.main(), x: MAIN_X - WAIT_CHOICE_DISTANCE, w: 60, h: 60 };
  }

  /** Next free slot of the branch column, level with `alignY` when that slot is free. */
  branch(alignY?: number): Position {
    const y = Math.max(alignY ?? this.branchY, this.branchY);
    this.branchY = y + ROW;
    return { x: BRANCH_X, y };
  }

  data(): Position {
    const y = this.dataY;
    this.dataY += DATA_ROW;
    return { x: DATA_X, y };
  }
}
