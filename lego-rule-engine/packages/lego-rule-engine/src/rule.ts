import { Condition, ConditionConstructorOptions, ICouldHavePriority } from './condition';
import { RuleResult } from './rule-result';
import { EventEmitter } from 'events';
import { Action } from './action.interface';
import { Engine } from './engine';
import { Almanac } from './almanac';

let debug = require('debug')('json-rules-engine');

export interface RuleConstructorOptions {
  conditions: ConditionConstructorOptions;
  event: Action;
  priority?: number | string;
}

export class Rule extends EventEmitter implements ICouldHavePriority {
  priority?: number;
  conditions?: Condition;
  event?: Action;
  engine?: Engine;
  /**
   * returns a new Rule instance
   * @param {object,string} options, or json string that can be parsed into options
   * @param {integer} options.priority (>1) - higher runs sooner.
   * @param {Object} options.event - event to fire when rule evaluates as successful
   * @param {string} options.event.type - name of event to emit
   * @param {string} options.event.params - parameters to pass to the event listener
   * @param {Object} options.conditions - conditions to evaluate when processing this rule
   * @return {Rule} instance
   */
  constructor(options: string | RuleConstructorOptions) {
    let scopedOptions;
    super();
    if (typeof options === 'string') {
      scopedOptions = JSON.parse(options);
    } else {
      scopedOptions = options;
    }
    if (scopedOptions && scopedOptions.conditions) {
      this.setConditions(scopedOptions.conditions);
    }
    if (scopedOptions && scopedOptions.onSuccess) {
      this.on('success', scopedOptions.onSuccess);
    }
    if (scopedOptions && scopedOptions.onFailure) {
      this.on('failure', scopedOptions.onFailure);
    }

    let priority = (scopedOptions && scopedOptions.priority) || 1;
    this.setPriority(priority);

    let event = (scopedOptions && scopedOptions.event) || { type: 'unknown' };
    this.setEvent(event);
  }

  /**
   * Sets the priority of the rule
   * @param {integer} priority (>=1) - increasing the priority causes the rule to be run prior to other rules
   */
  setPriority(priority: number | string) {
    priority = parseInt(priority as string, 10);

    if (priority <= 0) {
      throw new Error('Priority must be greater than zero');
    }

    this.priority = priority;
    return this;
  }

  /**
   * Sets the conditions to run when evaluating the rule.
   * @param {object} conditions - conditions, root element must be a boolean operator
   */
  setConditions(conditions: ConditionConstructorOptions) {
    if (!conditions.hasOwnProperty('all') && !conditions.hasOwnProperty('any')) {
      throw new Error('"conditions" root must contain a single instance of "all" or "any"');
    }
    this.conditions = new Condition(conditions);
    return this;
  }

  /**
   * Sets the event to emit when the conditions evaluate truthy
   * @param {object} event - event to emit
   * @param {string} event.type - event name to emit on
   * @param {string} event.params - parameters to emit as the argument of the event emission
   */
  setEvent(event: Action) {
    if (!event) throw new Error('Rule: setEvent() requires event object');
    if (!event.hasOwnProperty('type'))
      throw new Error('Rule: setEvent() requires event object with "type" property');
    this.event = {
      type: event.type
    };
    if (event.params) this.event.params = event.params;
    return this;
  }

  /**
   * Sets the engine to run the rules under
   * @param {object} engine
   * @returns {Rule}
   */
  setEngine(engine: Engine) {
    this.engine = engine;
    return this;
  }

  toJSON(
    stringify = true
  ):
    | string
    | {
        conditions: any;
        priority: number | string | undefined;
        event: Action | undefined;
      } {
    let props = {
      conditions: this.conditions ? this.conditions.toJSON(false) : null,
      priority: this.priority,
      event: this.event
    };
    if (stringify) {
      return JSON.stringify(props);
    }
    return props;
  }

  /**
   * Priorizes an array of conditions based on "priority"
   *   When no explicit priority is provided on the condition itself, the condition's priority is determine by its fact
   * @param  {Condition[]} conditions
   * @return {Condition[][]} prioritized two-dimensional array of conditions
   *    Each outer array element represents a single priority(integer).  Inner array is
   *    all conditions with that priority.
   */
  prioritizeConditions(conditions: Condition[]): Condition[][] {
    let factSets = conditions.reduce((sets, condition) => {
      // if a priority has been set on this specific condition, honor that first
      // otherwise, use the fact's priority
      let priority = condition.priority;

      if (!priority) {
        let fact = this.engine ? this.engine.getFact(condition.fact) : null;
        priority = (fact && fact.priority) || 1;
      }

      if (!sets[priority]) {
        sets[priority] = [];
      }

      sets[priority].push(condition);

      return sets;
    }, {});

    return Object.keys(factSets)
      .sort((a, b) => {
        return Number(a) > Number(b) ? -1 : 1; // order highest priority -> lowest
      })
      .map(priority => factSets[priority]);
  }

  /**
   * Evaluates the rule, starting with the root boolean operator and recursing down
   * All evaluation is done within the context of an almanac
   * @return {Promise(RuleResult)} rule evaluation result
   */
  evaluate(almanac: Almanac): Promise<RuleResult> {
    if (!this.conditions) {
      throw new Error('Rule: evaluate () requires the rule to have a conditions property');
    }
    let ruleResult = new RuleResult(this.conditions, this.event, this.priority);

    /**
     * Evaluates the rule conditions
     * @param  {Condition} condition - condition to evaluate
     * @return {Promise(true|false)} - resolves with the result of the condition evaluation
     */
    let evaluateCondition = (condition: Condition): Promise<boolean> => {
      if (condition.isBooleanOperator()) {
        let subConditions = condition.operator ? condition[condition.operator] : null;
        let comparisonPromise;
        if (condition.operator === 'all') {
          comparisonPromise = allOperation(subConditions as Condition[]);
        } else {
          comparisonPromise = anyOperation(subConditions as Condition[]);
        }
        // for booleans, rule passing is determined by the all/any result
        return comparisonPromise.then(comparisonValue => {
          let passes = comparisonValue === true;
          condition.result = passes;
          return passes;
        });
      } else {
        return condition
          .evaluate(almanac, this.engine!.operators)
          .then(evaluationResult => {
            let passes = evaluationResult.result;
            condition.factResult = evaluationResult.leftHandSideValue;
            condition.result = passes;
            return passes;
          })
          .catch(err => {
            // any condition raising an undefined fact error is considered falsey when allowUndefinedFacts is enabled
            if (this.engine!.allowUndefinedFacts && err.code === 'UNDEFINED_FACT') return false;
            throw err;
          });
      }
    };

    /**
     * Evalutes an array of conditions, using an 'every' or 'some' array operation
     * @param  {Condition[]} conditions
     * @param arrConditionMethod
     * @return {Promise(boolean)} whether conditions evaluated truthy or falsey based on condition evaluation + method
     */
    let evaluateConditions = (
      conditions: Condition[],
      arrConditionMethod: <T>(
        callbackfn: (value: T, index: number, array: T[]) => boolean,
        thisArg?: any
      ) => boolean
    ) => {
      if (!Array.isArray(conditions)) {
        conditions = [conditions];
      }

      return Promise.all(conditions.map(condition => evaluateCondition(condition))).then(
        conditionResults => {
          debug(`rule::evaluateConditions results`, conditionResults);
          return arrConditionMethod.call(conditionResults, (result: boolean) => result === true);
        }
      );
    };

    /**
     * Evaluates a set of conditions based on an 'all' or 'any' operator.
     *   First, orders the top level conditions based on priority
     *   Iterates over each priority set, evaluating each condition
     *   If any condition results in the rule to be guaranteed truthy or falsey,
     *   it will short-circuit and not bother evaluating any additional rules
     * @param  {Condition[]} conditions - conditions to be evaluated
     * @param  {string('all'|'any')} operator
     * @return {Promise(boolean)} rule evaluation result
     */
    let prioritizeAndRun = (conditions: Condition[], operator: 'all' | 'any'): Promise<boolean> => {
      if (conditions.length === 0) {
        return Promise.resolve(true);
      }
      let method = Array.prototype.some;
      if (operator === 'all') {
        method = Array.prototype.every;
      }
      let orderedSets = this.prioritizeConditions(conditions);
      let cursor = Promise.resolve<boolean>(null as any);
      orderedSets.forEach(set => {
        let stop = false;
        cursor = cursor.then((setResult: boolean | void) => {
          // after the first set succeeds, don't fire off the remaining promises
          if ((operator === 'any' && setResult === true) || stop) {
            debug(`prioritizeAndRun::detected truthy result; skipping remaining conditions`);
            stop = true;
            return true;
          }

          // after the first set fails, don't fire off the remaining promises
          if ((operator === 'all' && setResult === false) || stop) {
            debug(`prioritizeAndRun::detected falsey result; skipping remaining conditions`);
            stop = true;
            return false;
          }
          // all conditions passed; proceed with running next set in parallel
          return evaluateConditions(set, method);
        });
      });
      return cursor;
    };

    /**
     * Runs an 'any' boolean operator on an array of conditions
     * @param  {Condition[]} conditions to be evaluated
     * @return {Promise(boolean)} condition evaluation result
     */
    const anyOperation = (conditions: Condition[]) => {
      return prioritizeAndRun(conditions, 'any');
    };

    /**
     * Runs an 'all' boolean operator on an array of conditions
     * @param  {Condition[]} conditions to be evaluated
     * @return {Promise(boolean)} condition evaluation result
     */
    let allOperation = (conditions: Condition[]) => {
      return prioritizeAndRun(conditions, 'all');
    };

    /**
     * Emits based on rule evaluation result, and decorates ruleResult with 'result' property
     * @param {Boolean} result
     */
    let processResult = (result: any) => {
      ruleResult.setResult(result);

      if (result) this.emit('success', ruleResult.event, almanac, ruleResult);
      else this.emit('failure', ruleResult.event, almanac, ruleResult);
      return ruleResult;
    };

    if (ruleResult.conditions.any) {
      return anyOperation(ruleResult.conditions.any as Condition[]).then(result =>
        processResult(result)
      );
    } else {
      return allOperation(ruleResult.conditions.all as Condition[]).then(result =>
        processResult(result)
      );
    }
  }
}