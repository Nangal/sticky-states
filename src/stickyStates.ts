import {
  UIRouter, PathFactory, StateOrName, State, StateDeclaration, PathNode, TreeChanges, Transition, UIRouterPluginBase,
  TransitionHookPhase, TransitionHookScope, TransitionServicePluginAPI, HookMatchCriteria, TransitionStateHookFn,
  HookRegOptions, PathType, find, tail, isString, isArray, inArray, removeFrom, pushTo, identity, anyTrueR, assertMap,
  uniqR, defaultTransOpts
} from "ui-router-core";

declare module "ui-router-core/lib/state/interface" {
  interface StateDeclaration {
    sticky?: boolean;
    onInactivate?: TransitionStateHookFn;
    onReactivate?: TransitionStateHookFn;
  }
}

declare module "ui-router-core/lib/state/stateObject" {
  interface State {
    sticky?: boolean;
    onInactivate?: TransitionStateHookFn;
    onReactivate?: TransitionStateHookFn;
  }
}

declare module "ui-router-core/lib/transition/transitionService" {
  interface TransitionService {
    onInactivate: (criteria: HookMatchCriteria, callback: TransitionStateHookFn, options?: HookRegOptions) => Function;
    onReactivate: (criteria: HookMatchCriteria, callback: TransitionStateHookFn, options?: HookRegOptions) => Function;
  }
}

declare module "ui-router-core/lib/transition/interface" {
  interface TransitionOptions {
    exitSticky: StateOrName[]|StateOrName;
  }

  interface TreeChanges {
    inactivating?: PathNode[];
    reactivating?: PathNode[];
  }

  export interface IMatchingNodes {
    inactivating: PathNode[];
    reactivating: PathNode[];
  }

  export interface PathTypes {
    inactivating: PathType;
    reactivating: PathType;
  }

  export interface HookMatchCriteria {
    /** A [[HookMatchCriterion]] to match any state that would be inactivating */
    inactivating?: HookMatchCriterion;
    /** A [[HookMatchCriterion]] to match any state that would be reactivating */
    reactivating?: HookMatchCriterion;
  }
}

export class StickyStatesPlugin extends UIRouterPluginBase {
  name = "stickystates";
  private _inactives: PathNode[] = [];
  private pluginAPI: TransitionServicePluginAPI;

  constructor(public router: UIRouter) {
    super();

    this.pluginAPI = router.transitionService._pluginapi;

    this._defineStickyPaths();
    this._defineStickyEvents();
    this._addCreateHook();
    this._addStateCallbacks();
    this._addDefaultTransitionOption();
  }

  inactives() {
    return this._inactives.map(node => node.state.self);
  }

  private _addCreateHook() {
    this.router.transitionService.onCreate({}, (trans) => {
      trans['_treeChanges'] = this._calculateStickyTreeChanges(trans)
    });
  }

  private _defineStickyPaths() {
    let paths = this.pluginAPI._getPathTypes();
    this.pluginAPI._definePathType("inactivating", TransitionHookScope.STATE);
    this.pluginAPI._definePathType("reactivating", TransitionHookScope.STATE);
  }

  private _defineStickyEvents() {
    let paths = this.pluginAPI._getPathTypes();
    this.pluginAPI._defineEvent("onInactivate", TransitionHookPhase.ASYNC, 5, paths.inactivating, true);
    this.pluginAPI._defineEvent("onReactivate", TransitionHookPhase.ASYNC, 35, paths.reactivating);
  }

  // Process state.onInactivate or state.onReactivate callbacks
  private _addStateCallbacks() {
    var inactivateCriteria = { inactivating: state => !!state.onInactivate };
    this.router.transitionService.onInactivate(inactivateCriteria, (trans: Transition, state: State) =>
        state.onInactivate(trans, state));

    var reactivateCriteria = { reactivating: state => !!state.onReactivate };
    this.router.transitionService.onReactivate(reactivateCriteria, (trans: Transition, state: State) =>
        state.onReactivate(trans, state));
  }


  private _calculateExitSticky(tc: TreeChanges, trans: Transition) {
    // Process the inactive states that are going to exit due to $stickyState.reset()
    let exitSticky = trans.options().exitSticky || [];
    if (!isArray(exitSticky)) exitSticky = [exitSticky];

    let $state = trans.router.stateService;

    let states: State[] = (exitSticky as any[])
        .map(assertMap((stateOrName) => $state.get(stateOrName), (state) => "State not found: " + state))
        .map(state => state.$$state());

    let exitingInactives = states.map(assertMap(state => this._inactives.find(node => node.state === state), (state) => "State not inactive: " + state));
    let exiting = this._inactives.filter(isDescendantOfAny(exitingInactives));

    exiting.map(assertMap(node => !inArray(tc.to, node), (node) => "Can not exit a sticky state that is currently active/activating: " + node.state.name));

    return exiting;
  }

  private _calculateStickyTreeChanges(trans: Transition): TreeChanges {
    let tc: TreeChanges = trans.treeChanges();
    tc.inactivating = [];
    tc.reactivating = [];

    /****************
     * Process states that are about to be inactivated
     ****************/

    if (tc.entering.length && tc.exiting[0] && tc.exiting[0].state.sticky) {
      tc.inactivating = tc.exiting;
      tc.exiting = [];
    }

    /****************
     * Determine which states are about to be reactivated
     ****************/

    // Simulate a transition where the fromPath is a clone of the toPath, but use the inactivated nodes
    // This will calculate which inactive nodes that need to be exited/entered due to param changes
    let inactiveFromPath = tc.retained.concat(tc.entering.map(node => this._getInactive(node) || null)).filter(identity);
    let simulatedTC = PathFactory.treeChanges(inactiveFromPath, tc.to, trans.options().reloadState);

    let shouldRewritePaths = ['retained', 'entering', 'exiting'].some(path => !!simulatedTC[path].length);

    if (shouldRewritePaths) {
      // The 'retained' nodes from the simulated transition's TreeChanges are the ones that will be reactivated.
      // (excluding the nodes that are in the original retained path)
      tc.reactivating = simulatedTC.retained.slice(tc.retained.length);

      // Entering nodes are the same as the simulated transition's entering
      tc.entering = simulatedTC.entering;

      // The simulatedTC 'exiting' nodes are inactives that are being exited because:
      // - The inactive state's params changed
      // - The inactive state is being reloaded
      // - The inactive state is a child of the to state
      tc.exiting = tc.exiting.concat(simulatedTC.exiting);

      // Rewrite the to path
      tc.to = tc.retained.concat(tc.reactivating).concat(tc.entering);
    }

    /****************
     * Determine which additional inactive states should be exited
     ****************/

    let inactives = this._inactives;

    // Any inactive state whose parent state is exactly activated will be exited
    let childrenOfToState = inactives.filter(isChildOf(tail(tc.to)));

    // Any inactive non-sticky state whose parent state is activated (and is itself not activated) will be exited
    let childrenOfToPath = inactives.filter(isChildOfAny(tc.to))
        .filter(notInArray(tc.to))
        .filter(node => !node.state.sticky);

    let exitingChildren = childrenOfToState.concat(childrenOfToPath).filter(notInArray(tc.exiting));

    let exitingRoots = tc.exiting.concat(exitingChildren);

    // Any inactive descendant of an exiting state will be exited
    let orphans = inactives.filter(isDescendantOfAny(exitingRoots))
        .filter(notInArray(exitingRoots))
        .concat(exitingChildren)
        .reduce<PathNode[]>(uniqR, [])
        .sort(nodeDepthThenInactivateOrder(inactives));

    tc.exiting = orphans.concat(tc.exiting);

    // commit all changes to inactives after transition is successful
    trans.onSuccess({}, () => {
      tc.exiting.forEach(removeFrom(this._inactives));
      tc.entering.forEach(removeFrom(this._inactives));
      tc.reactivating.forEach(removeFrom(this._inactives));
      tc.inactivating.forEach(pushTo(this._inactives));
    });

    // console.log('inactives will be:', inactives.map(x => x.state.name));

    // let tcCopy: any = Object.assign({}, tc);
    // Object.keys(tcCopy).forEach(key => tcCopy[key] = tcCopy[key].map(x => x.state.name));
    // console.table(tcCopy);

    let exitSticky = this._calculateExitSticky(tc, trans);
    exitSticky.filter(notInArray(tc.exiting)).forEach(pushTo(tc.exiting));

    return tc;
  }


  private _addDefaultTransitionOption() {
    defaultTransOpts.exitSticky = []
  }

  /**
   * Exits inactive sticky state(s)
   *
   * #### Example:
   * ```js
   * $stickyState.exitSticky('inactivestate');
   * ```
   *
   * ```js
   * $stickyState.exitSticky([ 'inactivestate1', 'inactivestate2' ]);
   * ```
   *
   * ```js
   * // exit all inactive stickies
   * $stickyState.exitSticky();
   * ```
   *
   * ```js
   * // exit all inactive stickies
   * $stickyState.exitSticky($stickyState.inactives());
   * ```
   * @param states The state name, or an array of state names
   */
  exitSticky();
  exitSticky(states: StateOrName);
  exitSticky(states: StateOrName[]);
  exitSticky(states?: any) {
    let $state = this.router.stateService;
    if (states === undefined) states = this._inactives.map(node => node.state.name);
    if (isString(states)) states = [states];

    return $state.go($state.current, {}, {
      inherit: true,
      exitSticky: states
    });
  }

  _getInactive = (node) =>
    node && find(this._inactives, n => n.state === node.state);
}

const notInArray = (arr: any[]) => (item) => !inArray(arr, item);

const isChildOf = (parent: PathNode) =>
    (node: PathNode) =>
    node.state.parent === parent.state;

const isChildOfAny = (_parents: PathNode[]) => {
    return (node: PathNode) =>
        _parents.map(parent => isChildOf(parent)(node)).reduce(anyTrueR, false);
};

const ancestorPath = (state: State) =>
    state.parent ? ancestorPath(state.parent).concat(state) : [state];

const isDescendantOf = (_ancestor: PathNode) => {
    let ancestor = _ancestor.state;
    return (node: PathNode) =>
        ancestorPath(node.state).indexOf(ancestor) !== -1;
};

const isDescendantOfAny = (ancestors: PathNode[]) =>
    (node: PathNode) =>
        ancestors.map(ancestor => isDescendantOf(ancestor)(node))
            .reduce(anyTrueR, false);

function findStickyAncestor(state: State) {
  return state.sticky ? state : findStickyAncestor(state.parent);
}

/**
 * Sorts fn that sorts by:
 * 1) node depth (how deep a state is nested)
 * 2) the order in which the state was inactivated (later in wins)
 */
function nodeDepthThenInactivateOrder(inactives: PathNode[]) {
  return function(l: PathNode, r: PathNode): number {
    let depthDelta = (l.state.path.length - r.state.path.length);
    return depthDelta !== 0 ? depthDelta : inactives.indexOf(r) - inactives.indexOf(l);
  }
}
